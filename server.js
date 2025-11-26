import WebSocket from "ws";
import fetch from "node-fetch";
import express from "express";

// CONFIG
const WS_URL = "wss://ws.cs2run.app/connection/websocket";
const TOKEN_URL = "https://cs2run.app/current-state";
const CHANNEL = "csgorun:crash";

const PONG_WAIT_MS = 26000; // отправляем pong только после ping
const HEARTBEAT_INTERVAL = 5 * 60 * 1000; // каждые 5 минут
const MAX_LOG = 2000;

// STATE
let ws = null;
let logs = [];
let sessionStartTs = null;
let lastPongTs = null;
let pongTimer = null;
let sessionActiveLogger = null;

function addLog(obj) {
  obj.ts = new Date().toISOString();
  logs.push(obj);
  if (logs.length > MAX_LOG) logs.shift();
}

function sessionDuration() {
  if (!sessionStartTs) return 0;
  return Date.now() - sessionStartTs;
}

function human(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

async function getToken() {
  try {
    const r = await fetch(TOKEN_URL, { cache: "no-store" });
    const j = await r.json();
    return j?.data?.main?.centrifugeToken || null;
  } catch {
    return null;
  }
}

async function connectWs() {
  const token = await getToken();
  if (!token) {
    addLog({ event: "token_missing" });
    console.log("[TOKEN] missing — retry in 3s");
    setTimeout(connectWs, 3000);
    return;
  }

  console.log("[RUN] connecting...");
  addLog({ event: "start_connect", channel: CHANNEL });

  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    sessionStartTs = Date.now();
    lastPongTs = Date.now();

    console.log("[WS] OPEN");
    addLog({ event: "ws_open" });

    ws.send(
      JSON.stringify({
        id: 1,
        connect: { token }
      })
    );

    setTimeout(() => {
      ws.send(JSON.stringify({ id: 100, subscribe: { channel: CHANNEL } }));
      addLog({ event: "subscribe_sent", channel: CHANNEL });
      console.log("[WS->] subscribe", CHANNEL);
    }, 250);
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString("utf8"));

      if (msg?.connect?.ping === 25) {
        console.log("[WS] CONNECT ACK");
        addLog({ event: "connect_ack" });
        return;
      }

      // Игровой спам игнорируем полностью
      if (msg?.publ?.data) {
        return;
      }

      console.log("[WS MSG]", msg);
      addLog({ event: "msg", msg });
    } catch {
      addLog({ event: "msg_bin", size: data.length });
    }
  });

  ws.on("ping", () => {
    console.log("[PING] <- server");
    addLog({ event: "ping_recv" });

    try {
      ws.pong();
      lastPongTs = Date.now();
      addLog({ event: "pong_sent" });
      console.log("[PONG] -> sent");
    } catch {
      addLog({ event: "pong_err" });
    }

    if (pongTimer) clearTimeout(pongTimer);
    pongTimer = setTimeout(() => {
      console.log("[TIMEOUT] No PING — close");
      ws.close();
    }, PONG_WAIT_MS + 5000);
  });

  ws.on("close", (code, reason) => {
    const dur = sessionDuration();
    console.log(`[WS] CLOSE ${code} after ${dur}ms`);
    addLog({
      event: "ws_close",
      code,
      reason: reason?.toString(),
      duration_ms: dur,
      duration_human: human(dur)
    });

    resetHeartbeat();
    setTimeout(connectWs, 2000);
  });

  ws.on("error", (err) => {
    console.log("[WS ERROR]", err.message);
    addLog({ event: "ws_error", error: err.message });
  });

  startHeartbeat();
}

function startHeartbeat() {
  if (sessionActiveLogger) clearInterval(sessionActiveLogger);
  sessionActiveLogger = setInterval(() => {
    if (!sessionStartTs) return;
    console.log(
      `[HEARTBEAT] session live: ${human(sessionDuration())}, last pong=${new Date(
        lastPongTs
      ).toISOString()}`
    );
    addLog({ event: "heartbeat", duration_ms: sessionDuration() });
  }, HEARTBEAT_INTERVAL);
}

function resetHeartbeat() {
  sessionStartTs = null;
  if (sessionActiveLogger) clearInterval(sessionActiveLogger);
  sessionActiveLogger = null;
  if (pongTimer) clearTimeout(pongTimer);
}

// HTTP ENDPOINTS
const app = express();

app.get("/", (req, res) => res.send("ok"));

app.get("/status", (req, res) => {
  res.json({
    connected: ws?.readyState === WebSocket.OPEN,
    duration_ms: sessionDuration(),
    duration_human: human(sessionDuration()),
    last_pong: lastPongTs ? new Date(lastPongTs).toISOString() : null,
    log_entries: logs.length
  });
});

app.get("/logs", (req, res) => {
  res.json({ count: logs.length, tail: logs });
});

app.listen(10000, () => console.log("[HTTP] listening 10000"));

connectWs();