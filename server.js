// server.js — merged: стабильный WS (из "Рабочий вебсокет рана") + расширенное логирование / endpoints
// ES module syntax (node >= 18/20/22)
import WebSocket from "ws";
import fetch from "node-fetch";
import http from "http";
import os from "os";
import fs from "fs";
import path from "path";

const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const TOKEN_URL = process.env.TOKEN_URL || "https://cs2run.app/current-state";
const CHANNEL = process.env.CHANNEL || "public:status"; // тихий публичный канал
const PORT = Number(process.env.PORT || 8080);

// behavior tuning
const JSON_PONG_INTERVAL_MS = 22_000; // base ~22s
const JSON_PONG_JITTER = 1500; // +/- jitter
const FIRST_VERBOSE_MS = 5 * 60_000; // первые 5 минут показываем ping/pong подробно
const SESSION_ACTIVE_LOG_INTERVAL_MS = 10 * 60_000; // 10 минут отметка "session active"
const MAX_LOG_ENTRIES = Number(process.env.MAX_LOG_ENTRIES) || 20000; // circular buffer

// in-memory state
let ws = null;
let running = true;
let logs = []; // circular buffer of plain objects
let sessionStart = null;
let lastPongSentAt = null;
let lastPingRecvAt = null;
let lastClose = null;
let clientId = null;
let jsonPongTimer = null;
let sessionActiveTicker = null;

function pushLog(obj) {
  obj.ts = new Date().toISOString();
  logs.push(obj);
  if (logs.length > MAX_LOG_ENTRIES) logs.splice(0, logs.length - MAX_LOG_ENTRIES);
}

function safeParseJsonMaybe(buf) {
  try {
    const txt = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

async function fetchToken() {
  try {
    const r = await fetch(TOKEN_URL, { cache: "no-store", timeout: 5000 });
    const j = await r.json();
    const token = j?.data?.main?.centrifugeToken;
    pushLog({ event: "token_fetch", ok: !!token });
    return token || null;
  } catch (e) {
    pushLog({ event: "token_fetch_error", error: String(e) });
    return null;
  }
}

function startJsonPongLoop(wsInstance) {
  // start timer only after connect_ack
  stopJsonPongLoop();
  function scheduleNext() {
    const jitter = Math.round((Math.random() * 2 - 1) * JSON_PONG_JITTER);
    const delay = JSON_PONG_INTERVAL_MS + jitter;
    jsonPongTimer = setTimeout(async () => {
      if (!wsInstance || wsInstance.readyState !== WebSocket.OPEN) return;
      try {
        const msg = JSON.stringify({ type: 3 });
        wsInstance.send(msg);
        lastPongSentAt = Date.now();
        pushLog({ event: "json_pong_sent", payload: { type: 3 }, ts_sent: new Date().toISOString() });
        // schedule next
        scheduleNext();
      } catch (e) {
        pushLog({ event: "json_pong_error", error: String(e) });
      }
    }, delay);
    pushLog({ event: "json_pong_timer_scheduled", next_in_ms: delay });
  }
  scheduleNext();
}

function stopJsonPongLoop() {
  if (jsonPongTimer) {
    clearTimeout(jsonPongTimer);
    jsonPongTimer = null;
  }
}

function startSessionActiveTicker() {
  stopSessionActiveTicker();
  sessionActiveTicker = setInterval(() => {
    if (sessionStart && ws && ws.readyState === WebSocket.OPEN) {
      const durMs = Date.now() - sessionStart;
      pushLog({ event: "session_active_mark", duration_ms: durMs, human: msToHuman(durMs) });
      console.log(`[SESSION ACTIVE] ${msToHuman(durMs)}`);
    }
  }, SESSION_ACTIVE_LOG_INTERVAL_MS);
}

function stopSessionActiveTicker() {
  if (sessionActiveTicker) {
    clearInterval(sessionActiveTicker);
    sessionActiveTicker = null;
  }
}

function msToHuman(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function attachWsHandlers(wsInstance) {
  wsInstance.on("open", () => {
    sessionStart = Date.now();
    clientId = null;
    lastPongSentAt = null;
    lastPingRecvAt = null;
    pushLog({ event: "ws_open", url: WS_URL });
    console.log("[WS] OPEN");
    startSessionActiveTicker();
  });

  wsInstance.on("message", (data, isBinary) => {
    // try to parse binary frames as JSON (many server frames are binary JSON)
    const parsed = safeParseJsonMaybe(data);
    if (parsed) {
      // handle important control messages
      if (parsed.id === 1 && parsed.connect) {
        // server sent connect ack/info (often mirrored)
        clientId = parsed.connect.client || clientId;
        pushLog({ event: "connect_ack", client: clientId, info: parsed.connect });
        // start json pong loop only after connect ack
        startJsonPongLoop(wsInstance);
      } else if (parsed.id && (parsed.id >= 100 && parsed.id < 200) && parsed.error) {
        // subscribe ack/error messages
        pushLog({ event: "subscribe_ack_or_error", id: parsed.id, error: parsed.error });
      } else if (parsed.push) {
        // PUSH messages from channels — ignore payload content to avoid spam
        pushLog({ event: "push_ignored", channel: parsed.push.channel });
        // do not store parsed.push.pub or push.pub.data to reduce noise
      } else {
        // store other parsed messages but keep them lightweight
        pushLog({ event: "message_parsed", parsed: parsed });
      }
    } else {
      // non-JSON or unparsable binary — store a small sample
      const sample = Buffer.isBuffer(data) ? data.slice(0, 128).toString("hex") : String(data).slice(0, 256);
      pushLog({ event: "message_raw", sample });
    }

    // console output: keep concise
    if (Date.now() - (sessionStart || 0) < FIRST_VERBOSE_MS) {
      console.log("[WS MSG]", parsed ?? "(binary)");
    }
  });

  // transport-level ping frame arrived
  wsInstance.on("ping", (data) => {
    lastPingRecvAt = Date.now();
    pushLog({ event: "transport_ping_recv", hex: data ? data.toString("hex") : null });
    // respond immediately on transport level
    try {
      wsInstance.pong(data);
      pushLog({ event: "transport_pong_sent", hex: data ? data.toString("hex") : null });
      if (Date.now() - (sessionStart || 0) < FIRST_VERBOSE_MS) console.log("[WS TRANSPORT PING] -> pong sent");
    } catch (e) {
      pushLog({ event: "transport_pong_error", error: String(e) });
    }
  });

  wsInstance.on("pong", (data) => {
    pushLog({ event: "transport_pong_recv", hex: data ? data.toString("hex") : null });
    if (Date.now() - (sessionStart || 0) < FIRST_VERBOSE_MS) console.log("[WS TRANSPORT PONG recv]");
  });

  wsInstance.on("close", (code, reason) => {
    const reasonStr = reason && reason.length ? reason.toString() : "";
    const dur = sessionStart ? (Date.now() - sessionStart) : 0;
    lastClose = { code, reason: reasonStr, at: new Date().toISOString(), duration_ms: dur, human: msToHuman(dur) };
    pushLog({ event: "ws_close", code, reason: reasonStr, duration_ms: dur, human: msToHuman(dur) });
    console.log(`[WS] CLOSE code=${code} reason=${reasonStr} duration=${msToHuman(dur)}`);
    stopJsonPongLoop();
    stopSessionActiveTicker();
  });

  wsInstance.on("error", (err) => {
    pushLog({ event: "ws_error", error: String(err) });
    console.error("[WS] ERROR", err?.message || err);
  });
}

async function runOnce() {
  const token = await fetchToken();
  if (!token) {
    console.log("[RUN] token not found, retry in 3s");
    await new Promise((r) => setTimeout(r, 3000));
    return runOnce();
  }

  pushLog({ event: "start_connect", ws_url: WS_URL, channel: CHANNEL, token_present: !!token });
  console.log("[RUN] connecting to", WS_URL);

  ws = new WebSocket(WS_URL);

  attachWsHandlers(ws);

  // wait open then send connect + subscribe (subscribe quiet)
  await new Promise((resolve) => ws.once("open", resolve));

  // send connect (keep similar shape to browser)
  try {
    const payload = { id: 1, connect: { token, subs: {} } };
    ws.send(JSON.stringify(payload));
    pushLog({ event: "connect_sent", payload: { id: 1 } });
    console.log("[WS->] CONNECT sent");
  } catch (e) {
    pushLog({ event: "connect_send_error", error: String(e) });
  }

  // small delay then subscribe to chosen channel (but ignore PUSH contents)
  await new Promise((r) => setTimeout(r, 200));
  try {
    const sub = { id: 100, subscribe: { channel: CHANNEL } };
    ws.send(JSON.stringify(sub));
    pushLog({ event: "subscribe_sent", channel: CHANNEL, id: 100 });
    console.log(`[WS->] subscribe ${CHANNEL}`);
  } catch (e) {
    pushLog({ event: "subscribe_send_error", error: String(e) });
  }

  // keep alive until socket closed
  await new Promise((resolve) => {
    ws.once("close", resolve);
    ws.once("error", resolve);
  });

  // when closed — cleanup already in handlers; return to caller to decide reconnect
}

// HTTP server for /status and /logs
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/status") {
    const up = ws && ws.readyState === WebSocket.OPEN;
    const now = Date.now();
    const sessionAge = sessionStart ? now - sessionStart : 0;
    const payload = {
      connected: !!up,
      clientId,
      sessionStart: sessionStart ? new Date(sessionStart).toISOString() : null,
      sessionAgeMs: sessionAge,
      sessionAgeHuman: msToHuman(sessionAge),
      lastPongSentAt: lastPongSentAt ? new Date(lastPongSentAt).toISOString() : null,
      lastPingRecvAt: lastPingRecvAt ? new Date(lastPingRecvAt).toISOString() : null,
      lastClose,
    };
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(payload, null, 2));
  }

  if (req.method === "GET" && req.url === "/logs") {
    // return tail of logs
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ count: logs.length, tail: logs.slice(-100) }, null, 2));
  }

  // root health
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok\n");
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log("[HTTP] listening", PORT);
  pushLog({ event: "http_listen", port: PORT });
});

// main runner: reconnect loop only on ws close (no periodic forced reconnect)
let reconnecting = false;
async function mainLoop() {
  while (running) {
    try {
      await runOnce();
      // after runOnce returns it means ws closed; attempt reconnect with small backoff
      pushLog({ event: "reconnect_backoff", backoff_ms: 2000 });
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      pushLog({ event: "main_error", error: String(e) });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

mainLoop().catch((e) => {
  console.error("[FATAL]", e);
  process.exit(1);
});

// graceful cleanup
process.on("SIGINT", () => {
  running = false;
  if (ws) try { ws.close(); } catch (e) {}
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  running = false;
  if (ws) try { ws.close(); } catch (e) {}
  server.close(() => process.exit(0));
});