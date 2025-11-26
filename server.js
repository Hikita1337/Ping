// server.js
import WebSocket from "ws";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://pdsuiqmddqsllarznceh.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBkc3VpcW1kZHFzbGxhcnpuY2VoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MTc4MjM5MywiZXhwIjoyMDc3MzU4MzkzfQ.oz3-A6R7V7FM2ZKyTV1BrMEhrZKvTherL9sCyCteIXE";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Настройки
const WS_URL = "wss://ws.cs2run.app/connection/websocket";
const CHANNELS = ["csgorun:crash", "csgorun:main"];
const RECONNECT_INTERVAL_MS = 5 * 60 * 1000; // 5 минут
const FORCE_RESTART_ON_NO_PONG_MS = 35_000; // запас от ~25s
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ORIGIN = "https://csgoyz.run"; // подставляем origin сайта

let ws = null;
let reconnectTimer = null;
let forceReconnectTimer = null;
let lastTransportPingTs = 0;
let clientId = null;

async function logEvent(event, source, payload = null) {
  // Записываем минимальную суть (вариант B)
  try {
    await supabase.from("ws_events").insert({
      event,
      source,
      payload: payload ? JSON.stringify(payload) : null,
      created_at: new Date().toISOString()
    });
  } catch (e) {
    // не падаем при ошибке логирования — выводим в консоль
    console.warn("[LOG->DB ERR]", event, e?.message || e);
  }
  console.log(`[LOG] ${event} ${source}` + (payload ? ` ${JSON.stringify(payload)}` : ""));
}

async function getToken() {
  try {
    const r = await fetch("https://cs2run.app/current-state", { cache: "no-store" });
    const j = await r.json();
    return j?.data?.main?.centrifugeToken || null;
  } catch (e) {
    console.warn("[TOKEN] fetch failed", e?.message || e);
    return null;
  }
}

function cleanTimers() {
  if (forceReconnectTimer) { clearTimeout(forceReconnectTimer); forceReconnectTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function scheduleForceReconnect() {
  if (forceReconnectTimer) clearTimeout(forceReconnectTimer);
  forceReconnectTimer = setTimeout(() => {
    console.log("[WATCHDOG] force reconnect timer fired");
    safeClose();
  }, RECONNECT_INTERVAL_MS);
}

function safeClose() {
  try {
    if (ws && ws.readyState === ws.OPEN) ws.close();
  } catch (e){}
}

async function startClient() {
  const token = await getToken();
  if (!token) {
    console.log("[START] no token, retry in 3s");
    setTimeout(startClient, 3000);
    return;
  }

  // Создание WS с поддельными заголовками
  const headers = {
    "User-Agent": UA,
    "Origin": ORIGIN
  };

  console.log("[START] connecting...");
  ws = new WebSocket(WS_URL, { headers });

  ws.once("open", () => {
    console.log("[WS] OPEN");
    logEvent("open", "client");

    // отправляем connect минимально (вариант B)
    const connectMsg = { id: 1, connect: { token, subs: {} } };
    ws.send(JSON.stringify(connectMsg));
    logEvent("connect_sent", "client");

    // schedule forced reconnect every RECONNECT_INTERVAL_MS
    scheduleForceReconnect();
  });

  // Transport-level ping handler: когда сервер шлёт PING frame
  ws.on("ping", (data) => {
    lastTransportPingTs = Date.now();
    try {
      ws.pong(data); // важная часть — отвечаем transport PONG теми же данными
      logEvent("transport_pong_sent", "client");
      console.log("[TRANSPORT] ping => pong (auto)");
    } catch (e) {
      console.warn("[TRANSPORT] pong error", e?.message || e);
    }
  });

  ws.on("pong", (data) => {
    // Если сервер/peer присылает pong — фиксируем
    logEvent("transport_pong_rcv", "client");
    console.log("[TRANSPORT] pong received");
  });

  ws.on("message", (raw) => {
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch (e) {
      // Игнорируем ненужные бинары/прочее
      console.debug("[MSG] non-json message (ignored)");
      return;
    }

    // Центрифуго/JSON-level может приходить как объект или массив
    const arr = Array.isArray(msg) ? msg : [msg];
    for (const m of arr) {
      console.debug("[WS MSG]", JSON.stringify(m).slice(0,400));
      // Если это JSON-level ping
      if (m.ping !== undefined) {
        // логируем только факт JSON ping
        logEvent("json_ping", "server");
        // отвечаем JSON pong (имитируем клиент)
        try {
          ws.send(JSON.stringify({ pong: {} }));
          logEvent("json_pong", "client");
        } catch (e) {
          console.warn("[JSON PONG] send error", e?.message || e);
        }
        continue;
      }

      // Connect ACK (result for id 1)
      if (m.result && m.id === 1) {
        // сервер может возвращать client id внутри connect ack
        if (m.result && m.result.connect && m.result.connect.client) {
          clientId = m.result.connect.client;
        } else if (m.connect && m.connect.client) {
          clientId = m.connect.client;
        }
        logEvent("connect_ok", "server", { clientId });
        // После connect_ok делаем subscribe на каналы (вариант B)
        setTimeout(() => {
          CHANNELS.forEach((ch, idx) => {
            const subMsg = { id: 100 + idx, subscribe: { channel: ch } };
            try {
              ws.send(JSON.stringify(subMsg));
              logEvent("subscribe_sent", "client", { channel: ch, id: 100 + idx });
            } catch (e) {}
          });
        }, 200);
        continue;
      }

      // SUBSCRIBE ACK
      if ((m.id === 100) || (m.id === 101) || (m.subscribe !== undefined && Object.keys(m.subscribe).length===0)) {
        // минимальная запись — sub ok
        logEvent("sub_ok", "server", { id: m.id });
        continue;
      }

      // Игровые push — игнорируем запись в БД (вариант B)
      if (m.push) {
        // не логируем payload, но можно логировать факт прихода (опционально)
        // logEvent("push_ignored", "server", { channel: m.push.channel });
        continue;
      }

      // Все прочие редкие сообщения — логируем в сжатом виде
      logEvent("other_message", "server", { sample: JSON.stringify(m).slice(0,400) });
    }
  });

  ws.on("close", (code, reason) => {
    console.log("[CLOSE]", code, reason?.toString?.() || reason);
    logEvent("close", "server", { code, reason: reason?.toString?.() || null });
    cleanTimers();
    // Перезапуск через 2 секунды
    reconnectTimer = setTimeout(() => startClient(), 2000);
  });

  ws.on("error", (err) => {
    console.warn("[WS ERR]", err?.message || err);
    logEvent("error", "client", { msg: String(err?.message || err) });
    // на ошибке тоже рестартим
    try { ws.close(); } catch(e){}
  });

  // watchdog: если за FORCE_RESTART_ON_NO_PONG_MS не было transport ping/pong — перезапустить
  if (forceReconnectTimer) clearTimeout(forceReconnectTimer);
  forceReconnectTimer = setTimeout(function watch() {
    // Если последний transport ping старше порога и сокет открыт — перезапуск
    const age = Date.now() - (lastTransportPingTs || 0);
    if (age > FORCE_RESTART_ON_NO_PONG_MS && ws && ws.readyState === WebSocket.OPEN) {
      console.log("[WATCHDOG] no transport ping recently -> restart");
      logEvent("watchdog_restart", "client", { lastPingAge: age });
      safeClose();
    }
    // ставим следующий чек
    forceReconnectTimer = setTimeout(watch, FORCE_RESTART_ON_NO_PONG_MS);
  }, FORCE_RESTART_ON_NO_PONG_MS);

  // планируем периодический полный переподключ (чтоб учесть возможные server side rotations)
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log("[AUTO] periodic reconnect");
    safeClose();
  }, RECONNECT_INTERVAL_MS);
}

// Запускаем
startClient().catch(err => {
  console.error("[FATAL]", err);
  process.exit(1);
});