// server.js — final stable sniffer (public:status, JSON binary PONG, silent pushes)
// Node >= 18/20/22, "type":"module" in package.json
import WebSocket from "ws";
import fetch from "node-fetch";
import express from "express";
import os from "os";

const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const TOKEN_URL = process.env.TOKEN_URL || "https://cs2run.app/current-state";
const CHANNEL = process.env.CHANNEL || "public:status"; // chosen channel
const MAX_BYTES = Number(process.env.MAX_LOG_BYTES || 100 * 1024 * 1024); // 100 MB memory cap
const MAX_ENTRIES = Number(process.env.MAX_LOG_ENTRIES || 20000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 5 * 60 * 1000); // 5 minutes
const PORT = Number(process.env.PORT || 10000); // Render free opens 10000

let ws = null;
let pongTimer = null;
let sessionStart = null;
let sessionActive = false;
let reconnecting = false;

// in-memory log store (capped by bytes & entries)
const logs = [];
let approxBytes = 0;
function pushLog(obj) {
  obj.ts = new Date().toISOString();
  const txt = JSON.stringify(obj);
  const b = Buffer.byteLength(txt, "utf8");
  logs.push(obj);
  approxBytes += b;
  // trim by bytes first, then by entries
  while ((approxBytes > MAX_BYTES && logs.length > 1) || logs.length > MAX_ENTRIES) {
    const removed = logs.shift();
    approxBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
  }
}

// conservative filter for high-volume game pushes
const SPAM_PATTERNS = [
  "crash", "csgorun", "main", "game", "bet", "topBet", "gameStatistics", "push"
].map(s => s.toLowerCase());

function isSpamChannelName(name) {
  if (!name || typeof name !== "string") return false;
  const n = name.toLowerCase();
  return SPAM_PATTERNS.some(p => n.includes(p));
}

async function fetchToken() {
  try {
    const r = await fetch(TOKEN_URL, { cache: "no-store" });
    const j = await r.json();
    const token = j?.data?.main?.centrifugeToken;
    pushLog({ event: "token_fetch", ok: !!token });
    return token || null;
  } catch (e) {
    pushLog({ event: "token_fetch_error", error: String(e) });
    return null;
  }
}

function safeParse(buf) {
  try {
    const txt = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function startPongTimer(pingSeconds = 25) {
  clearPongTimer();
  const baseMs = Math.max(1000, Math.floor(pingSeconds * 1000) - 2000);
  function scheduleNext() {
    const jitter = Math.floor(Math.random() * 1200) - 600; // ±600ms
    const next = Math.max(1000, baseMs + jitter);
    pongTimer = setTimeout(() => {
      sendJsonPong();
      scheduleNext();
    }, next);
    pushLog({ event: "pong_timer_scheduled", next_ms: next });
  }
  scheduleNext();
  pushLog({ event: "pong_timer_started", baseMs });
}

function clearPongTimer() {
  if (pongTimer) {
    clearTimeout(pongTimer);
    pongTimer = null;
    pushLog({ event: "pong_timer_cleared" });
  }
}

function sendJsonPong() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    // send binary JSON {"type":3}
    const payload = Buffer.from(JSON.stringify({ type: 3 }), "utf8");
    ws.send(payload, { binary: true });
    pushLog({ event: "pong_sent", payload_summary: '{"type":3}', time: new Date().toISOString() });
    console.log("[PONG] binary JSON sent -> {\"type\":3}");
  } catch (e) {
    pushLog({ event: "pong_send_error", error: String(e) });
  }
}

function humanDuration(ms) {
  if (!ms) return "0s";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

async function runOnce() {
  const token = await fetchToken();
  if (!token) {
    pushLog({ event: "no_token_retry" });
    console.log("[RUN] no token, retry in 3s");
    await new Promise(r => setTimeout(r, 3000));
    return;
  }

  pushLog({ event: "start_connect", ws_url: WS_URL, channel: CHANNEL });
  console.log("[RUN] connecting to", WS_URL);

  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    pushLog({ event: "ws_open" });
    console.log("[WS] OPEN");
    reconnecting = false;
  });

  ws.on("message", (data, isBinary) => {
    const size = Buffer.isBuffer(data) ? data.length : String(data).length;
    const parsed = safeParse(data);
    if (parsed && parsed.connect && parsed.id === 1) {
      pushLog({ event: "connect_ack", info: parsed.connect });
      console.log("[WS MSG] connect ack/info:", parsed.connect);
      sessionStart = Date.now();
      sessionActive = true;
      const pingSec = Number(parsed.connect.ping) || 25;
      startPongTimer(pingSec);
    } else if (parsed && parsed.id && (parsed.id === 100 || parsed.id === 101)) {
      pushLog({ event: "sub_response", id: parsed.id, payload: parsed });
      if (parsed.error) {
        console.log("[WS MSG JSON] sub response (error):", parsed);
      } else {
        console.log("[WS MSG JSON] sub ok id=", parsed.id);
      }
    } else if (parsed && parsed.push) {
      const ch = parsed.push.channel;
      if (isSpamChannelName(ch)) {
        pushLog({ event: "push_ignored", channel: ch, summary: "spam_ignored" });
      } else {
        pushLog({ event: "push", channel: ch, data: parsed.push.pub });
      }
    } else {
      const summary = parsed || (isBinary ? "<binary-non-json>" : String(data).slice(0, 500));
      pushLog({ event: "message", isBinary: !!isBinary, size, parsed: parsed ? parsed : undefined, sample: !parsed ? String(data).slice(0,200) : undefined });
      if (parsed) console.log("[WS MSG JSON]", parsed);
      else console.log("[WS MSG] sample:", String(data).slice(0, 160));
    }
  });

  ws.on("close", (code, reasonBuf) => {
    const reason = reasonBuf && reasonBuf.length ? reasonBuf.toString() : "";
    const endedAt = Date.now();
    const durationMs = sessionStart ? (endedAt - sessionStart) : 0;
    pushLog({ event: "ws_close", code, reason: reason || "(none)", duration_ms: durationMs, duration_human: humanDuration(durationMs) });
    console.log(`[WS] CLOSE code=${code} reason=${reason || "(none)"} duration=${humanDuration(durationMs)}`);
    clearPongTimer();
    sessionActive = false;
    sessionStart = null;
  });

  ws.on("error", (err) => {
    pushLog({ event: "ws_error", error: String(err) });
    console.error("[WS] ERROR", err?.message || err);
  });

  ws.on("ping", (data) => {
    pushLog({ event: "transport_ping", hex: data ? data.toString("hex") : null });
    console.log("[WS TRANSPORT PING] seen");
  });

  ws.on("pong", (data) => {
    pushLog({ event: "transport_pong", hex: data ? data.toString("hex") : null });
  });

  // wait until socket ends (close or error)
  await new Promise((resolve) => {
    ws.once("close", () => resolve());
    ws.once("error", () => resolve());
  });

  // small backoff
  await new Promise(r => setTimeout(r, 800));
}

let stopping = false;
async function mainLoop() {
  while (!stopping) {
    try {
      await runOnce();
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      pushLog({ event: "main_error", error: String(e) });
      console.error("[MAIN ERR]", e);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// HTTP endpoints
const app = express();

app.get("/", (req, res) => res.send("ok"));

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    ws_url: WS_URL,
    channel: CHANNEL,
    sessionActive,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    logs_count: logs.length
  });
});

app.get("/logs", (req, res) => {
  const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 1000)));
  const out = logs.slice(-limit);
  res.json({ count: out.length, tail: out });
  if (req.query.clear === "1") {
    logs.length = 0;
    approxBytes = 0;
    pushLog({ event: "logs_cleared_via_endpoint" });
  }
});

app.get("/last", (req, res) => {
  res.json(logs.length ? logs[logs.length - 1] : { cnt: 0 });
});

app.listen(PORT, () => {
  console.log("[HTTP] listening", PORT);
  pushLog({ event: "http_listen", port: PORT });
  mainLoop().catch(e => {
    pushLog({ event: "main_loop_fatal", error: String(e) });
    console.error("[FATAL]", e);
    process.exit(1);
  });
});

setInterval(() => {
  if (sessionActive && sessionStart) {
    const dur = Date.now() - sessionStart;
    console.log(`[HEARTBEAT] session active: ${humanDuration(dur)} logs:${logs.length}`);
    pushLog({ event: "heartbeat", session_duration_ms: dur, logs_count: logs.length });
  } else {
    console.log(`[HEARTBEAT] no active session. logs:${logs.length}`);
    pushLog({ event: "heartbeat_no_session", logs_count: logs.length });
  }
}, HEARTBEAT_INTERVAL_MS);

process.on("SIGINT", () => {
  console.log("SIGINT -> stopping");
  stopping = true;
  try { if (ws) ws.close(); } catch {}
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("SIGTERM -> stopping");
  stopping = true;
  try { if (ws) ws.close(); } catch {}
  process.exit(0);
});