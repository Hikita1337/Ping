// server.js
import WebSocket from "ws";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

/*
  Настройки — можно перенести в env vars (рекомендую).
  Если не задать, используются значения по-умолчанию ниже.
*/
const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const CHANNELS = [
  "system:public" /* пример служебного канала (если нужен реальный - см. логи) */,
  "status"            /* твой выбор: status */
];
const RECONNECT_INTERVAL_MS = 5 * 60 * 1000; // форс-реконнект каждые 5 мин
const MAX_BACKOFF_MS = 5 * 60 * 1000; // максимум backoff 5 минут
const BASE_BACKOFF_MS = 1000; // стартовый backoff 1s
const UA = process.env.UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ORIGIN = process.env.ORIGIN || "https://csgoyz.run"; // ставим origin сайта

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || "https://pdsuiqmddqsllarznceh.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBkc3VpcW1kZHFzbGxhcnpuY2VoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MTc4MjM5MywiZXhwIjoyMDc3MzU4MzkzfQ.oz3-A6R7V7FM2ZKyTV1BrMEhrZKvTherL9sCyCteIXE";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Таблица: ws_events (см. SQL ниже)
async function logEvent(event, source, payload = null) {
  // минимальная запись — не падаем при ошибке
  try {
    await supabase.from("ws_events").insert({
      event,
      source,
      payload: payload ? JSON.stringify(payload) : null,
      created_at: new Date().toISOString()
    });
  } catch (e) {
    // не делаем shutdown в случае ошибок логирования
    console.warn("[LOG->DB ERR]", event, e?.message || e);
  }
  console.log(`[LOG] ${event} ${source}` + (payload ? ` ${JSON.stringify(payload)}` : ""));
}

// token fetch
async function getToken() {
  try {
    const r = await fetch("https://cs2run.app/current-state", { cache: "no-store" });
    const j = await r.json();
    return j?.data?.main?.centrifugeToken || null;
  } catch (e) {
    console.warn("[TOKEN] fetch error", e?.message || e);
    return null;
  }
}

// State
let ws = null;
let stopped = false;
let attempt = 0;
let lastTransportPingTs = 0;
let periodicReconnectTimer = null;
let backoffTimer = null;

// graceful shutdown support
process.on("SIGINT", () => { console.log("SIGINT"); stopped = true; safeClose(); process.exit(0); });
process.on("SIGTERM", () => { console.log("SIGTERM"); stopped = true; safeClose(); process.exit(0); });

// safe close helper
function safeClose() {
  try {
    if (ws && ws.readyState === ws.OPEN) ws.close();
  } catch (e) {}
}

// main connect function
async function startClient() {
  if (stopped) return;
  const token = await getToken();
  if (!token) {
    console.log("[START] token missing — retry in 3s");
    return setTimeout(startClient, 3000);
  }

  const headers = {
    "User-Agent": UA,
    "Origin": ORIGIN
  };

  // connect
  console.log("[START] connecting...");
  ws = new WebSocket(WS_URL, { headers });

  // set small flags
  let gotConnectAck = false;
  let connectPending = true;
  let forcedReconnectHandle = null;

  // Helpers
  function schedulePeriodicReconnect() {
    if (periodicReconnectTimer) clearTimeout(periodicReconnectTimer);
    periodicReconnectTimer = setTimeout(() => {
      console.log("[AUTO] periodic force reconnect");
      logEvent("force_reconnect", "client");
      safeClose();
    }, RECONNECT_INTERVAL_MS);
  }

  ws.once("open", () => {
    attempt = 0; // reset backoff on success
    console.log("[WS] OPEN");
    logEvent("open", "client");

    // Immediately send transport-level pong (helps some servers)
    try {
      ws.pong();
      logEvent("transport_pong_sent", "client");
    } catch (e) {
      console.warn("[transport_pong_sent] error", e?.message || e);
    }

    // Send minimal CONNECT (variant B - minimal subs:{})
    const connectMsg = { id: 1, connect: { token, subs: {} } };
    ws.send(JSON.stringify(connectMsg));
    logEvent("connect_sent", "client", { token_present: !!token });

    schedulePeriodicReconnect();

    // watchdog: if transport pings stop being seen — schedule restart after a reasonable time
    if (forcedReconnectHandle) clearTimeout(forcedReconnectHandle);
    forcedReconnectHandle = setTimeout(function watch() {
      const age = Date.now() - (lastTransportPingTs || 0);
      // if very old and socket still open -> force restart
      if (ws && ws.readyState === WebSocket.OPEN && age > 60_000 /* 60s */) {
        console.log("[WATCHDOG] no transport ping seen for", age, "ms -> restart");
        logEvent("watchdog_restart", "client", { age });
        safeClose();
      } else {
        // reschedule watcher
        forcedReconnectHandle = setTimeout(watch, 30_000);
      }
    }, 30_000);
  });

  // transport-level ping -> respond with pong (binary)
  ws.on("ping", (data) => {
    lastTransportPingTs = Date.now();
    try {
      ws.pong(data);
      logEvent("transport_pong_sent", "client");
      console.log("[TRANSPORT] ping -> pong");
    } catch (e) {
      console.warn("[TRANSPORT] pong error", e?.message || e);
    }
  });

  ws.on("pong", (data) => {
    lastTransportPingTs = Date.now();
    logEvent("transport_pong_rcv", "client");
    console.log("[TRANSPORT] pong received");
  });

  ws.on("message", (raw) => {
    // raw is usually string JSON; if binary arrives, ignore for now
    let text = null;
    try { text = String(raw); } catch { text = null; }

    if (!text) {
      // binary or non-text message — optionally record head
      logEvent("binary_message_ignored", "server");
      return;
    }

    // parse JSON safely
    let msg = null;
    try { msg = JSON.parse(text); } catch (e) {
      // not JSON — ignore
      logEvent("nonjson_message_ignored", "server", { sample: text.slice(0,200) });
      return;
    }

    // If protocol sends an array of messages, iterate
    const arr = Array.isArray(msg) ? msg : [msg];
    for (const m of arr) {
      // --- JSON-level ping (centrifugo) ---
      if (m.ping !== undefined) {
        logEvent("json_ping", "server", m.ping || {});
        // reply JSON PONG — minimal
        try {
          ws.send(JSON.stringify({ pong: {} }));
          logEvent("json_pong_sent", "client");
        } catch (e) {
          console.warn("[json_pong_sent] error", e?.message || e);
        }
        continue;
      }

      // --- CONNECT ACK variations ---
      // server may reply: { id:1, connect: {...} } or { result: { connect: {...} }, id:1 }
      if ((m.id === 1 && m.connect) || (m.id === 1 && m.result && m.result.connect)) {
        // got connect ack
        if (!gotConnectAck) {
          gotConnectAck = true;
          logEvent("connect_ack", "server", { client: (m.connect||m.result?.connect)?.client || null });

          // Immediately send JSON PONG (after connect ack), then subscribe
          try {
            ws.send(JSON.stringify({ pong: {} }));
            logEvent("json_pong_sent", "client");
          } catch (e) {
            console.warn("[json_pong_sent] error", e?.message || e);
          }

          // Small delay before subscribe to mimic browser timing
          setTimeout(() => {
            CHANNELS.forEach((ch, idx) => {
              try {
                const sub = { id: 100 + idx, subscribe: { channel: ch } };
                ws.send(JSON.stringify(sub));
                logEvent("subscribe_sent", "client", { channel: ch, id: 100 + idx });
              } catch (e) {
                console.warn("[subscribe_sent] error", e?.message || e);
              }
            });
          }, 150);
        }
        continue;
      }

      // --- Subscribe ACKs ---
      if (m.id === 100 || m.id === 101) {
        logEvent("sub_ok", "server", { id: m.id });
        continue;
      }

      // --- push messages (игровые) ---
      if (m.push) {
        // intentionally IGNORE (variant B) — don't write payload to DB
        // optional: count them for rate control or metrics (not stored)
        // console.debug("[PUSH ignored]", m.push?.channel);
        continue;
      }

      // --- other messages — keep minimal sample logged ---
      logEvent("other_message", "server", { sample: JSON.stringify(m).slice(0,400) });
    }
  });

  ws.on("close", (code, reason) => {
    console.log("[CLOSE]", code, reason?.toString?.() || reason);
    logEvent("close", "server", { code, reason: reason?.toString?.() || null });

    // Clear periodic timers
    if (periodicReconnectTimer) { clearTimeout(periodicReconnectTimer); periodicReconnectTimer = null; }

    if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }

    // start reconnect with backoff
    attempt++;
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, Math.min(10, attempt)));
    console.log(`[RECONNECT] attempt=${attempt} backoff=${backoff}ms`);
    backoffTimer = setTimeout(() => {
      startClient();
    }, backoff);
  });

  ws.on("error", (err) => {
    console.warn("[WS ERROR]", err?.message || err);
    logEvent("error", "client", { msg: String(err?.message || err) });

    // close to trigger reconnect path
    try { ws.close(); } catch (e) {}
  });
}

// start main
startClient().catch(err => {
  console.error("[FATAL]", err);
  process.exit(1);
});