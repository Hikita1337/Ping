// server.js
import WebSocket from "ws";
import fetch from "node-fetch";

/**
 * Simple, robust WS client for testing handshake + ping/pong behavior.
 * - No DB writes
 * - No push payload logging (spam)
 * - Subscribes to system channel only (safe)
 * - Handles BOTH transport-level ping (ws 'ping' event) and JSON-level ping (message with .ping)
 * - Does NOT proactively send pongs on open; replies only when ping arrives (to avoid premature pong)
 * - Exponential backoff on reconnect + periodic forced reconnect every 5 minutes
 *
 * ENV:
 *  - WS_URL (default wss://ws.cs2run.app/connection/websocket)
 *  - ORIGIN (default https://csgoyz.run)
 *  - UA (optional user-agent)
 */

const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const ORIGIN = process.env.ORIGIN || "https://csgoyz.run";
const UA = process.env.UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// channels: only system (safe). we avoid crash push logging; can add crash later if needed.
const CHANNELS = ["system:public"]; // change to ["system:public","crash:public"] if you want subscribe to crash
const RECONNECT_FORCE_MS = 5 * 60 * 1000; // force reconnect every 5 min
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

let ws = null;
let stopped = false;
let attempt = 0;
let periodicReconnectTimer = null;
let backoffTimer = null;

// small helper logger (standardized)
function log(...args){ console.log(new Date().toISOString(), ...args); }

// fetch token helper
async function getToken() {
  try {
    const r = await fetch("https://cs2run.app/current-state", { cache: "no-store" });
    const j = await r.json();
    return j?.data?.main?.centrifugeToken || null;
  } catch (e) {
    log("[TOKEN] fetch error", (e && e.message) ? e.message : e);
    return null;
  }
}

function safeCloseSocket() {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  } catch(e){}
}

// start connection
async function startClient() {
  if (stopped) return;
  const token = await getToken();
  if (!token) {
    log("[START] token missing — retry in 3s");
    setTimeout(startClient, 3000);
    return;
  }

  // Add UA/Origin headers to be closer to browser behaviour
  const headers = { "Origin": ORIGIN, "User-Agent": UA };

  log("[START] connecting...", WS_URL);
  ws = new WebSocket(WS_URL, { headers });

  // state for this connection
  let gotConnectAck = false;
  let connectSent = false;
  let lastTransportPingTs = 0;

  // reset periodic reconnect
  function schedulePeriodicReconnect() {
    if (periodicReconnectTimer) clearTimeout(periodicReconnectTimer);
    periodicReconnectTimer = setTimeout(() => {
      log("[AUTO] periodic force reconnect");
      safeCloseSocket();
    }, RECONNECT_FORCE_MS);
  }

  ws.once("open", () => {
    attempt = 0;
    log("[WS] OPEN");
    // do not send any pong proactively — wait for server ping (transport or json)
    // send minimal connect (text JSON) like browser
    const connectMsg = { id: 1, connect: { token, subs: {} } };
    try {
      ws.send(JSON.stringify(connectMsg));
      connectSent = true;
      log("[LOG] connect_sent client", { token_present: !!token });
    } catch (e) {
      log("[ERR] send connect", e?.message || e);
    }

    schedulePeriodicReconnect();
  });

  // Transport-level ping handler — low-level binary ping
  ws.on("ping", (data) => {
    lastTransportPingTs = Date.now();
    log("[TRANSPORT] ping received (low-level)");
    try {
      // reply exactly with same data if present
      ws.pong(data);
      log("[TRANSPORT] pong sent (low-level)");
    } catch (e) {
      log("[TRANSPORT] pong error", e?.message || e);
    }
  });

  // Transport-level pong (when server replies to our pong or echo)
  ws.on("pong", (data) => {
    lastTransportPingTs = Date.now();
    log("[TRANSPORT] pong event received");
  });

  ws.on("message", (raw) => {
    // raw might be string or Buffer
    let text = null;
    if (typeof raw === "string") text = raw;
    else if (raw instanceof Buffer) {
      // try to decode buffer as utf8 string - may be binary envelope
      try { text = raw.toString("utf8"); }
      catch { text = null; }
    } else {
      try { text = String(raw); } catch { text = null; }
    }

    if (!text) {
      // binary that can't be decoded — just note it (debug only)
      log("[MSG] binary frame (ignored in current build)");
      return;
    }

    // Try parse JSON
    let msg = null;
    try { msg = JSON.parse(text); } catch (e) {
      // not JSON — ignore
      log("[MSG] non-json text (ignored)", text.slice(0,200));
      return;
    }

    // If array, iterate
    const arr = Array.isArray(msg) ? msg : [msg];
    for (const m of arr) {
      // JSON-level ping from Centrifugo-like protocol
      if (m.ping !== undefined) {
        log("[JSON] ping <- server", m.ping || {});
        // Reply JSON pong in the same format
        try {
          ws.send(JSON.stringify({ pong: {} }));
          log("[JSON] pong -> sent");
        } catch (e) {
          log("[ERR] json pong send", e?.message || e);
        }
        continue;
      }

      // Connect ack (server may send {id:1, connect: {...}} or {result:..., id:1})
      if ((m.id === 1 && m.connect) || (m.id === 1 && m.result && m.result.connect)) {
        if (!gotConnectAck) {
          gotConnectAck = true;
          const clientId = (m.connect && m.connect.client) || (m.result?.connect?.client) || null;
          log("[LOG] connect_ack server", { client: clientId });

          // After connect ack: subscribe to channels (only system/channel B handled by server)
          setTimeout(() => {
            CHANNELS.forEach((ch, idx) => {
              try {
                const sub = { id: 100 + idx, subscribe: { channel: ch } };
                ws.send(JSON.stringify(sub));
                log("[LOG] subscribe_sent client", { channel: ch, id: 100 + idx });
              } catch (e) {
                log("[ERR] subscribe send", e?.message || e);
              }
            });
          }, 120); // slight delay to mimic browser timing
        }
        continue;
      }

      // Subscribe ACK
      if (m.id === 100 || m.id === 101) {
        log("[LOG] sub_ok server", { id: m.id });
        continue;
      }

      // Push messages (Игровые push) — intentionally ignore to avoid spam
      if (m.push) {
        // We do NOT log push payloads in this build.
        // If you want to see one example for debug, enable below line.
        // log("[PUSH ignored] channel=", m.push.channel);
        continue;
      }

      // Other (rare) messages — log small sample
      try {
        log("[MSG other] sample", JSON.stringify(m).slice(0,300));
      } catch(e){}
    }
  });

  ws.on("close", (code, reason) => {
    log("[CLOSE]", code, reason?.toString?.() || reason);
    // cleanup timers
    if (periodicReconnectTimer) { clearTimeout(periodicReconnectTimer); periodicReconnectTimer = null; }
    if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }

    // reconnect with backoff
    attempt++;
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, Math.min(10, attempt)));
    log(`[RECONNECT] attempt=${attempt} backoff=${backoff}ms`);
    backoffTimer = setTimeout(() => {
      startClient();
    }, backoff);
  });

  ws.on("error", (err) => {
    log("[WS ERROR]", (err && err.message) ? err.message : err);
    // force close to trigger reconnect path
    try { if (ws) ws.close(); } catch(e){}
  });

  // watchdog: if no transport ping seen in 90s while socket open, force reconnect
  (function startWatchdog(){
    const id = setInterval(() => {
      if (!ws) return clearInterval(id);
      if (ws.readyState !== WebSocket.OPEN) return;
      const last = lastTransportPingTs || 0;
      const age = Date.now() - last;
      if (last !== 0 && age > 90_000) {
        log("[WATCHDOG] last transport ping age ms:", age, " — forcing reconnect");
        safeCloseSocket();
      }
    }, 30_000);
  })();
}

// start
startClient().catch(err => {
  console.error("[FATAL]", err);
  process.exit(1);
});

// graceful shutdown
process.on("SIGINT", () => {
  log("SIGINT — shutting down");
  stopped = true;
  safeCloseSocket();
  setTimeout(() => process.exit(0), 500);
});
process.on("SIGTERM", () => {
  log("SIGTERM — shutting down");
  stopped = true;
  safeCloseSocket();
  setTimeout(() => process.exit(0), 500);
});