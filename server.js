// server.js
// Stable CS2Run WebSocket client (console-only logging)
// - fetch token
// - connect to WS
// - subscribe to channels (log only subscription events)
// - respond to transport ping with same payload
// - initiate client ping every 25s (with short random payload) and measure latency
// - forced reconnect every 5 minutes
// - filter channel "push" payloads to avoid spam logging

import WebSocket from "ws";
import fetch from "node-fetch";
import crypto from "crypto";

const WS_URL = "wss://ws.cs2run.app/connection/websocket";
const CHANNELS = ["csgorun:crash", "csgorun:main"];

const CLIENT_PING_INTERVAL_MS = 25 * 1000; // 25s - client-initiated ping cadence
const FORCE_RECONNECT_MS = 5 * 60 * 1000; // 5 minutes forced reconnect
const TOKEN_RETRY_MS = 3000;

let ws = null;
let clientPingTimer = null;
let forceReconnectTimer = null;
let reconnectBackoffTimer = null;
let pendingClientPings = new Map(); // hex -> timestamp

function hex(buf) {
  if (!buf) return "(empty)";
  return Buffer.from(buf).toString("hex");
}

function info(...args){ console.log("[INFO]", ...args); }
function warn(...args){ console.warn("[WARN]", ...args); }
function error(...args){ console.error("[ERR]", ...args); }

async function getToken() {
  info("Requesting token...");
  try {
    const r = await fetch("https://cs2run.app/current-state", { cache: "no-store" });
    const j = await r.json();
    const token = j?.data?.main?.centrifugeToken || null;
    info("Token:", token ? "OK" : "MISSING");
    return token;
  } catch (e) {
    warn("Token fetch failed:", e?.message || e);
    return null;
  }
}

// send a client-level ping (transport ping with short random payload)
function sendClientPing() {
  if (!ws || ws.readyState !== ws.OPEN) return;
  // 2-byte random payload -> easier to inspect in logs
  const payload = crypto.randomBytes(2);
  const h = hex(payload);
  try {
    ws.ping(payload);
    pendingClientPings.set(h, Date.now());
    info("[CLIENT PING] ->", h);
  } catch (e) {
    warn("[CLIENT PING] failed:", e?.message || e);
  }
}

// clear timers and ws
function clearTimers() {
  if (clientPingTimer) { clearInterval(clientPingTimer); clientPingTimer = null; }
  if (forceReconnectTimer) { clearTimeout(forceReconnectTimer); forceReconnectTimer = null; }
  if (reconnectBackoffTimer) { clearTimeout(reconnectBackoffTimer); reconnectBackoffTimer = null; }
}

function safeCloseAndRestart(reason) {
  try {
    if (ws && ws.readyState === ws.OPEN) ws.close();
  } catch (e) {/* ignore */}
  // ensure timers cleared
  clearTimers();
  // schedule quick restart
  reconnectBackoffTimer = setTimeout(() => {
    startWS();
  }, 2000);
  info("[RESTART] scheduled because:", reason);
}

async function startWS() {
  const token = await getToken();
  if (!token) {
    warn("No token obtained — retrying in 3s");
    setTimeout(startWS, TOKEN_RETRY_MS);
    return;
  }

  info("Connecting to", WS_URL);
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    info("[WS] OPEN");
    // reset pending pings map (fresh session)
    pendingClientPings.clear();

    // send connect (handshake)
    const connectMsg = { id: 1, connect: { token, subs: {} } };
    try {
      ws.send(JSON.stringify(connectMsg));
      info("[WS->] CONNECT sent");
    } catch (e) {
      warn("Failed to send CONNECT:", e?.message || e);
    }

    // subscribe to channels (we log only the fact of subscription)
    setTimeout(() => {
      CHANNELS.forEach((ch, i) => {
        try {
          ws.send(JSON.stringify({ id: 100 + i, subscribe: { channel: ch } }));
          info("[SUBSCRIBE] requested:", ch);
        } catch (e) {
          warn("[SUBSCRIBE] send failed for", ch, e?.message || e);
        }
      });
    }, 200);

    // start client-initiated pings
    if (!clientPingTimer) {
      // send first ping quickly to kickstart keepalive
      sendClientPing();
      clientPingTimer = setInterval(sendClientPing, CLIENT_PING_INTERVAL_MS);
    }

    // schedule force reconnect every FORCE_RECONNECT_MS
    if (forceReconnectTimer) clearTimeout(forceReconnectTimer);
    forceReconnectTimer = setTimeout(() => {
      info("[WS] Force reconnect (5 minutes elapsed)");
      safeCloseAndRestart("forced-interval");
    }, FORCE_RECONNECT_MS);
  });

  // server-initiated transport ping
  ws.on("ping", (data) => {
    const h = hex(data);
    info("[SERVER PING] <-", h);
    // respond with identical payload
    try {
      ws.pong(data);
      info("[SERVER PONG] ->", h);
    } catch (e) {
      warn("[SERVER PONG] send failed:", e?.message || e);
    }
  });

  // pong received (can be response to client ping or server pong ack)
  ws.on("pong", (data) => {
    const h = hex(data);
    info("[PONG RCV] <-", h);
    // if this pong corresponds to a client-initiated ping, compute latency
    if (pendingClientPings.has(h)) {
      const sentTs = pendingClientPings.get(h);
      const latency = Date.now() - sentTs;
      pendingClientPings.delete(h);
      info("[LATENCY] (client ping) ->", latency + "ms");
      // optional: if latency too high, force reconnect
      if (latency > 2000) {
        warn("[WARN] high latency detected, forcing reconnect");
        safeCloseAndRestart("high-latency");
      }
    }
    // otherwise it may be a server echo to some other ping; we still logged it
  });

  ws.on("message", (raw) => {
    // filter noisy push messages from channels
    let parsed = null;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        // plain text: log at debug level
        // do not spam console with channel payloads, so only debug if needed
        return;
      }
    } else {
      // binary message from server as application payload (rare) - ignore
      return;
    }

    // core filter: ignore massive channel push payloads
    if (parsed && parsed.push) return;

    // log control results: connect/sub ack etc.
    if (parsed && parsed.result && parsed.id === 1) {
      info("[WS] CONNECT ACK");
      return;
    }
    if (parsed && parsed.result && parsed.id >= 100 && parsed.id < 200) {
      info("[WS] SUBSCRIBE ACK id=" + parsed.id);
      return;
    }

    // anything else that is not push -> show (rare)
    info("[MSG JSON]", JSON.stringify(parsed));
  });

  ws.on("close", (code, reason) => {
    info(`[WS] CLOSE code=${code} reason=${reason?.toString() || "(none)"}`);
    clearTimers();
    // immediate restart with small backoff
    setTimeout(startWS, 2000);
    info("[WS] Restarting in 2s");
  });

  ws.on("error", (err) => {
    warn("[WS] ERROR", err?.message || err);
    // ws will usually emit close after error; ensure restart
  });
}

// start
startWS();