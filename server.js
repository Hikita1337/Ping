// server.js — WS sniffer (final)
// ES module (Node >=18+). Requires "type":"module" in package.json
import WebSocket from "ws";
import fetch from "node-fetch";
import express from "express";
import os from "os";

// -------- CONFIG (env-overridable) --------
const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const TOKEN_URL = process.env.TOKEN_URL || "https://cs2run.app/current-state";
const CHANNELS = (process.env.CHANNELS || "system:public").split(",").map(s => s.trim()).filter(Boolean);
// RAM log limit in bytes (default 100 MiB)
const MAX_LOG_BYTES = Number(process.env.MAX_LOG_BYTES || 100 * 1024 * 1024);
// How often to print "session ok" to console (ms)
const SESSION_PULSE_MS = Number(process.env.SESSION_PULSE_MS || 5 * 60 * 1000);
// How many initial minutes to verbose-log pings
const VERBOSE_PING_MINUTES = Number(process.env.VERBOSE_PING_MINUTES || 5);
// Rough pong interval (ms) after connect_ack; jitter will be added
const PONG_INTERVAL_BASE_MS = Number(process.env.PONG_INTERVAL_BASE_MS || 22000);
// HTTP port (Render needs a bound port)
const PORT = Number(process.env.PORT || process.env.PORT_BIND || 10000);

// -------- In-memory log store (size-limited) --------
let logs = []; // array of entries
let logsBytes = 0;

function approxSizeBytes(obj) {
  try {
    return Buffer.byteLength(JSON.stringify(obj), "utf8");
  } catch {
    return 100;
  }
}

function pushLog(entry) {
  entry.ts = new Date().toISOString();
  const size = approxSizeBytes(entry);
  logs.push(entry);
  logsBytes += size;
  // Evict oldest until under limit (simple FIFO)
  while (logsBytes > MAX_LOG_BYTES && logs.length > 1) {
    const ev = logs.shift();
    logsBytes -= approxSizeBytes(ev);
  }
}

// -------- Utilities --------
function safeJSONParse(buf) {
  try {
    const txt = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function humanDuration(ms) {
  const sec = Math.floor(ms / 1000) % 60;
  const min = Math.floor(ms / 60000) % 60;
  const hrs = Math.floor(ms / 3600000);
  return `${String(hrs).padStart(2,"0")}:${String(min).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
}

// minimal heuristic: treat channels containing these substrings as "game pushes"
const GAME_CHANNEL_SUBSTR = ["crash", "main", "bet", "game", "topBet", "csgorun"];

// -------- State --------
let ws = null;
let sessionStart = null;
let sessionTimerHandle = null;
let sessionPulseHandle = null;
let pongTimerHandle = null;
let verbosePingWindowMs = VERBOSE_PING_MINUTES * 60 * 1000;
let lastConnectClientId = null;

// -------- Fetch token --------
async function fetchToken() {
  try {
    const r = await fetch(TOKEN_URL, { cache: "no-store", timeout: 5000 });
    const j = await r.json();
    const token = j?.data?.main?.centrifugeToken || j?.data?.centrifugeToken || null;
    pushLog({ type: "token_fetch", ok: !!token });
    return token;
  } catch (e) {
    pushLog({ type: "token_fetch_error", error: String(e) });
    return null;
  }
}

// -------- Behavior: send JSON PONG as binary after connect ack --------
function schedulePongLoop(wsInstance) {
  // clear previous
  if (pongTimerHandle) { clearTimeout(pongTimerHandle); pongTimerHandle = null; }
  const sendPong = () => {
    if (!wsInstance || wsInstance.readyState !== wsInstance.OPEN) return;
    const payload = Buffer.from(JSON.stringify({ type: 3 })); // binary JSON pong
    try {
      wsInstance.send(payload);
      pushLog({ type: "pong_sent", transport: "binary_json", payload: { type: 3 } });
      // schedule next with jitter +/- 1s
      const jitter = Math.floor((Math.random() - 0.5) * 2000);
      const next = Math.max(15000, PONG_INTERVAL_BASE_MS + jitter);
      pongTimerHandle = setTimeout(sendPong, next);
    } catch (e) {
      pushLog({ type: "pong_send_error", error: String(e) });
    }
  };
  // initial schedule: ~PONG_INTERVAL_BASE_MS with small jitter
  const initJitter = Math.floor((Math.random() - 0.5) * 2000);
  pongTimerHandle = setTimeout(sendPong, Math.max(15000, PONG_INTERVAL_BASE_MS + initJitter));
}

// -------- Create WS and handlers --------
async function startWSLoop() {
  while (true) {
    const token = await fetchToken();
    if (!token) {
      console.warn("[START] token not found, retrying in 3s");
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    try {
      console.log(`[RUN] connecting to ${WS_URL}`);
      pushLog({ type: "start_connect", url: WS_URL, token_present: true });

      ws = new WebSocket(WS_URL);

      // --- transport ping/pong frames
      ws.on("ping", (data) => {
        pushLog({ type: "transport_ping", hex: Buffer.isBuffer(data) ? data.toString("hex") : null });
        // reply immediately
        try { ws.pong(data); pushLog({ type: "transport_pong_sent" }); } catch (e) { pushLog({ type: "transport_pong_err", error: String(e) }); }
        // verbose
        if (Date.now() - (sessionStart || 0) < verbosePingWindowMs) {
          console.log("[TRANSPORT PING]");
        }
      });

      ws.on("pong", (data) => {
        pushLog({ type: "transport_pong_received", hex: Buffer.isBuffer(data) ? data.toString("hex") : null });
        if (Date.now() - (sessionStart || 0) < verbosePingWindowMs) {
          console.log("[TRANSPORT PONG RECV]");
        }
      });

      ws.on("open", async () => {
        sessionStart = Date.now();
        lastConnectClientId = null;
        pushLog({ type: "ws_open" });
        console.log("[WS] OPEN");

        // start session pulse
        if (sessionPulseHandle) clearInterval(sessionPulseHandle);
        sessionPulseHandle = setInterval(() => {
          if (sessionStart && ws && ws.readyState === ws.OPEN) {
            const uptime = humanDuration(Date.now() - sessionStart);
            console.log(`[SESSION OK] uptime=${uptime}`);
            pushLog({ type: "session_pulse", uptime });
          }
        }, SESSION_PULSE_MS);

        // send "connect" following Centrifuge protocol used by site
        const connectPayload = { id: 1, connect: { token, subs: {} } };
        try {
          ws.send(JSON.stringify(connectPayload));
          pushLog({ type: "connect_sent", payload: { ...connectPayload, token_present: true } });
          console.log("[WS->] CONNECT sent");
        } catch (e) {
          pushLog({ type: "connect_send_error", error: String(e) });
        }

        // wait a little then subscribe to chosen channels
        setTimeout(() => {
          CHANNELS.forEach((ch, i) => {
            try {
              const payload = { id: 100 + i, subscribe: { channel: ch } };
              ws.send(JSON.stringify(payload));
              pushLog({ type: "subscribe_sent", channel: ch, id: payload.id });
              console.log(`[WS->] subscribe ${ch}`);
            } catch (e) {
              pushLog({ type: "subscribe_send_error", channel: ch, error: String(e) });
            }
          });
        }, 200);
      });

      ws.on("message", (data, isBinary) => {
        // raw logging minimal to avoid spam; try to parse JSON
        const parsed = safeJSONParse(data);
        // If this is the connect ack (id===1 && connect)
        if (parsed && parsed.result && parsed.id === 1) {
          pushLog({ type: "connect_ack", payload: parsed });
          console.log("[WS MSG] CONNECTED ACK");
        }
        // some servers send connect as direct object {id:1, connect: {...}}
        if (parsed && parsed.id === 1 && parsed.connect) {
          lastConnectClientId = parsed.connect.client || lastConnectClientId;
          pushLog({ type: "connect_info", payload: parsed.connect });
          console.log(`[WS MSG] connect ack/info: ${JSON.stringify(parsed.connect)}`);
          // start JSON PONG loop only after connect ack/info
          schedulePongLoop(ws);
        }

        // If it's an empty JSON {} often used as keepalive — we log as lightweight
        if (parsed && Object.keys(parsed).length === 0) {
          pushLog({ type: "keepalive", raw: "{}" });
          // don't spam console for keepalive
          return;
        }

        // If message is a Centrifugo 'push' with game data -> ignore details (to avoid spam)
        if (parsed && parsed.push && parsed.push.channel) {
          const ch = String(parsed.push.channel || "");
          const isGame = GAME_CHANNEL_SUBSTR.some(sub => ch.includes(sub));
          if (isGame) {
            // count / note but don't store full push
            pushLog({ type: "push_ignored", channel: ch });
            return;
          }
        }

        // If message has id 100/101 subscribe ack or error => log
        if (parsed && (parsed.id === 100 || parsed.id === 101)) {
          pushLog({ type: "subscribe_msg", payload: parsed });
          console.log("[WS MSG JSON]", parsed);
          return;
        }

        // For other parsed JSON messages: store full content (careful with spam)
        if (parsed) {
          pushLog({ type: "message_json", payload: parsed });
          console.log("[WS MSG JSON]", parsed);
          return;
        }

        // If binary or non-JSON text, store a small sample: hex/base64/text snippet
        if (Buffer.isBuffer(data)) {
          const hexSample = data.slice(0, 160).toString("hex");
          const b64Sample = data.slice(0, 120).toString("base64");
          pushLog({ type: "message_binary", size: data.length, hex_sample: hexSample, base64_sample: b64Sample });
          console.log("[WS MSG BINARY] size=%d sample=%s", data.length, hexSample.slice(0, 120));
        } else {
          const txt = String(data).slice(0, 600);
          pushLog({ type: "message_text", text_sample: txt });
          console.log("[WS MSG TEXT]", txt);
        }
      });

      ws.on("close", (code, reason) => {
        const reasonStr = reason && reason.length ? reason.toString() : "";
        pushLog({ type: "ws_close", code, reason: reasonStr, session_uptime_ms: sessionStart ? Date.now() - sessionStart : 0 });
        console.log(`[WS] CLOSE code=${code} reason=${reasonStr}`);
        // cleanup timers
        if (sessionPulseHandle) { clearInterval(sessionPulseHandle); sessionPulseHandle = null; }
        if (pongTimerHandle) { clearTimeout(pongTimerHandle); pongTimerHandle = null; }
        sessionStart = null;
      });

      ws.on("error", (err) => {
        pushLog({ type: "ws_error", error: String(err) });
        console.error("[WS] ERROR", err?.message || err);
        // cleanup on error too
        if (sessionPulseHandle) { clearInterval(sessionPulseHandle); sessionPulseHandle = null; }
        if (pongTimerHandle) { clearTimeout(pongTimerHandle); pongTimerHandle = null; }
        sessionStart = null;
      });

      // wait until socket closed or error triggers
      await new Promise((resolve) => {
        ws.once("close", () => resolve());
        ws.once("error", () => resolve());
      });

      // on close -> loop will reconnect after short backoff
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      pushLog({ type: "main_loop_exception", error: String(e) });
      console.error("[MAIN] exception:", e);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// -------- HTTP endpoints (health + logs) --------
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("ok"));

// get logs (in-memory). Query params: limit (number), since (ISO ts)
// returns as JSON array { logs: [...], meta: {...} }
app.get("/logs", (req, res) => {
  const limit = Math.min(10000, Number(req.query.limit || 1000));
  const since = req.query.since ? new Date(req.query.since) : null;
  let out = logs;
  if (since && !isNaN(since.getTime())) {
    out = out.filter(e => new Date(e.ts) >= since);
  }
  out = out.slice(-limit);
  res.json({ meta: { total_stored: logs.length, bytes_est: logsBytes }, logs: out });
});

// quick endpoint to get summary
app.get("/status", (req, res) => {
  res.json({
    ws_url: WS_URL,
    channels: CHANNELS,
    connected: !!(ws && ws.readyState === ws.OPEN),
    clientId: lastConnectClientId,
    storedLogs: logs.length,
    storedBytes: logsBytes,
    uptime_ms: sessionStart ? Date.now() - sessionStart : 0,
  });
});

// Start HTTP server then WS loop
app.listen(PORT, () => {
  console.log("[HTTP] listening", PORT);
  pushLog({ type: "http_listen", port: PORT });
  // start WS loop asynchronously
  startWSLoop().catch(e => {
    pushLog({ type: "start_loop_error", error: String(e) });
    console.error("[FATAL] startWSLoop failed", e);
    process.exit(1);
  });
});

// graceful shutdown
process.on("SIGINT", () => {
  console.log("SIGINT -> shutting down");
  pushLog({ type: "shutdown", reason: "SIGINT" });
  try { if (ws) ws.close(); } catch {}
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("SIGTERM -> shutting down");
  pushLog({ type: "shutdown", reason: "SIGTERM" });
  try { if (ws) ws.close(); } catch {}
  process.exit(0);
});