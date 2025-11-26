// server.js — Combined: stable websocket behavior + filtered logging + HTTP status/logs
// ES module (Node 18+ / 20+ / 25+). Install dependencies: npm i ws
import WebSocket from "ws";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";

// ----- Config (via ENV) -----
const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const CHANNELS = (process.env.CHANNELS || "csgorun:crash").split(",").map(s => s.trim()).filter(Boolean);
const TOKEN_URL = process.env.TOKEN_URL || "https://cs2run.app/current-state";
const PORT = Number(process.env.PORT || 10000);
const MAX_LOG_ENTRIES = Number(process.env.MAX_LOG_ENTRIES || 2000);
const DUMP_INTERVAL_MS = Number(process.env.DUMP_INTERVAL_MS || 2 * 60 * 1000); // dump every 2 min
const LOG_PUSH_FULL = process.env.LOG_PUSH_FULL === "1" || false; // if true, log push full payloads
const SEND_PERIODIC_PONG = process.env.SEND_PERIODIC_PONG === "1" || false;
const PERIODIC_PONG_MS = Number(process.env.PERIODIC_PONG_MS || 22000);
const HEARTBEAT_LOG_INTERVAL_MS = Number(process.env.HEARTBEAT_LOG_INTERVAL_MS || 5 * 60 * 1000); // 5 minutes

// ----- State -----
let ws = null;
let running = true;
let reconnectAttempts = 0;
let logs = []; // circular buffer of log entries
let periodicPongTimer = null;
let sessionStartTs = null;
let lastPongTs = null;
let lastDisconnect = null;
let verboseUntil = 0; // timestamp until which we print pings/pongs (first 5 minutes)
const VERBOSE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

// ----- Utilities -----
function nowIso() { return (new Date()).toISOString(); }
function pushLog(entry) {
  entry.ts = nowIso();
  logs.push(entry);
  if (logs.length > MAX_LOG_ENTRIES) logs.splice(0, logs.length - MAX_LOG_ENTRIES);
  // Console output: keep important entries visible, but limit noise
  const noisyTypes = new Set(["raw_msg", "push_full"]);
  if (!noisyTypes.has(entry.type) || LOG_PUSH_FULL) {
    // pretty print important items
    console.log(JSON.stringify(entry));
  } else {
    // print only minimal marker for ignored pushes to show activity but avoid dump
    if (entry.type === "push_ignored") {
      console.log(`[${entry.ts}] PUSH IGNORED channel=${entry.channel}`);
    }
  }
}
function hex(buf) { if (!buf) return ""; return Buffer.isBuffer(buf) ? buf.toString("hex") : Buffer.from(String(buf)).toString("hex"); }
function b64(buf) { if (!buf) return ""; return Buffer.isBuffer(buf) ? buf.toString("base64") : Buffer.from(String(buf)).toString("base64"); }

async function fetchToken() {
  try {
    const r = await fetch(TOKEN_URL, { cache: "no-store" });
    const j = await r.json();
    const token = j?.data?.main?.centrifugeToken || null;
    pushLog({ type: "token_fetch", ok: !!token });
    return token;
  } catch (e) {
    pushLog({ type: "token_fetch_error", error: String(e) });
    return null;
  }
}

// ----- Build a JSON PONG buffer {"type":3} (binary) -----
function makeBinaryJsonPong() {
  return Buffer.from(JSON.stringify({ type: 3 }));
}

// ----- Attach websocket handlers -----
function attachWsHandlers(instance) {
  instance.on("open", () => {
    reconnectAttempts = 0;
    sessionStartTs = Date.now();
    lastPongTs = null;
    pushLog({ type: "ws_open", url: WS_URL });
    verboseUntil = Date.now() + VERBOSE_PERIOD_MS;
    console.log("[WS] OPEN");
  });

  instance.on("message", (data, isBinary) => {
    // raw entry
    const raw = {
      type: "raw_msg",
      isBinary: !!isBinary,
      size: Buffer.isBuffer(data) ? data.length : String(data).length,
      raw: {}
    };
    if (Buffer.isBuffer(data)) {
      raw.raw.hex = data.toString("hex");
      raw.raw.base64 = data.toString("base64");
    } else if (typeof data === "string") {
      raw.raw.text = data.slice(0, 3000);
    }

    // try parse JSON
    let parsed = null;
    try {
      const txt = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      parsed = JSON.parse(txt);
    } catch (e) {
      parsed = null;
    }
    if (parsed !== null) raw.parsed = parsed;

    pushLog(raw);

    // behavior for parsed messages
    if (parsed !== null) {
      // Centrifuge-like empty JSON ping `{}`
      const isEmptyObject = (typeof parsed === "object" && parsed && Object.keys(parsed).length === 0);
      if (isEmptyObject) {
        pushLog({ type: "server_ping_detected", note: "empty JSON frame {} received" });
        // reply immediately with binary JSON PONG ({"type":3})
        try {
          const pongBuf = makeBinaryJsonPong();
          instance.send(pongBuf, { binary: true }, (err) => {
            if (err) pushLog({ type: "send_error", error: String(err) });
            else {
              lastPongTs = Date.now();
              pushLog({ type: "json_pong_sent", reason: "server_empty_json", hex: pongBuf.toString("hex") });
            }
          });
          if (Date.now() < verboseUntil) console.log("[PONG] binary JSON sent ->", pongBuf.toString());
        } catch (e) {
          pushLog({ type: "pong_send_err", error: String(e) });
        }
        return;
      }

      // connect ack
      if (parsed.connect && parsed.id === 1) {
        pushLog({ type: "connect_ack", client: parsed.connect.client || null, meta: parsed.connect });
        console.log("[WS MSG] connect ack/info:", parsed.connect);
        // start periodic pong if configured
        if (SEND_PERIODIC_PONG) {
          if (periodicPongTimer) clearInterval(periodicPongTimer);
          const jitter = Math.floor(Math.random()*1600) - 800;
          const interval = Math.max(1000, PERIODIC_PONG_MS + jitter);
          periodicPongTimer = setInterval(() => {
            try {
              const b = makeBinaryJsonPong();
              instance.send(b, { binary: true }, (err) => {
                if (err) pushLog({ type: "periodic_pong_error", error: String(err) });
                else {
                  lastPongTs = Date.now();
                  pushLog({ type: "periodic_pong_sent", hex: b.toString("hex") });
                }
              });
              if (Date.now() < verboseUntil) console.log("[PERIODIC PONG] sent");
            } catch (e) {
              pushLog({ type: "periodic_pong_exception", error: String(e) });
            }
          }, interval);
          pushLog({ type: "periodic_pong_started", intervalMs: interval });
        }
        return;
      }

      // messages with id (ack/errs)
      if (parsed.id && typeof parsed.id !== "undefined") {
        pushLog({ type: "msg_with_id", id: parsed.id, raw: parsed });
        // minimal console output
        console.log(`[WS MSG ID] ${parsed.id}`);
        return;
      }

      // push messages (spammy) -> filter unless LOG_PUSH_FULL
      if (parsed.push) {
        const ch = parsed.push.channel || "(unknown)";
        if (LOG_PUSH_FULL) {
          pushLog({ type: "push_full", channel: ch, payload: parsed.push.pub });
          console.log("[WS PUSH]", ch, parsed.push.pub);
        } else {
          // keep a tiny marker only
          pushLog({ type: "push_ignored", channel: ch });
          if (Date.now() < verboseUntil) console.log("[WS PUSH IGNORED]", ch);
        }
        return;
      }

      // other structured messages
      pushLog({ type: "message_parsed", content: parsed });
      if (Date.now() < verboseUntil) console.log("[WS MSG PARSED]", parsed);
      return;
    }

    // non-json payload -> keep raw log only
    pushLog({ type: "message_nonjson", note: "non-json payload received" });
    if (Date.now() < verboseUntil) console.log("[WS MSG NON-JSON] size=", raw.size);
  });

  // transport ping/pong
  instance.on("ping", (data) => {
    pushLog({ type: "transport_ping", hex: hex(data), base64: b64(data) });
    if (Date.now() < verboseUntil) console.log("[TRANSPORT PING] hex=", hex(data));
    // reply transport-level pong
    try {
      instance.pong(data);
      pushLog({ type: "transport_pong_sent", hex: hex(data) });
      if (Date.now() < verboseUntil) console.log("[TRANSPORT PONG] sent");
    } catch (e) {
      pushLog({ type: "transport_pong_err", error: String(e) });
    }
  });

  instance.on("pong", (data) => {
    lastPongTs = Date.now();
    pushLog({ type: "transport_pong_recv", hex: hex(data), base64: b64(data) });
    if (Date.now() < verboseUntil) console.log("[TRANSPORT PONG RECV] hex=", hex(data));
  });

  instance.on("close", (code, reason) => {
    const rs = (reason && reason.length) ? reason.toString() : "";
    const durationMs = sessionStartTs ? (Date.now() - sessionStartTs) : 0;
    lastDisconnect = { code, reason: rs, duration_ms: durationMs, ts: nowIso() };
    pushLog({ type: "ws_close", code, reason: rs, duration_ms: durationMs });
    console.log(`[WS] CLOSE code=${code} reason=${rs} duration=${Math.round(durationMs/1000)}s`);
    // stop periodic pong timer
    if (periodicPongTimer) { clearInterval(periodicPongTimer); periodicPongTimer = null; pushLog({ type: "periodic_pong_stopped" }); }
    // reset sessionStartTs (we'll reconnect in main loop)
    sessionStartTs = null;
  });

  instance.on("error", (err) => {
    pushLog({ type: "ws_error", error: String(err) });
    console.error("[WS ERROR]", err?.message || err);
  });
}

// ----- Main loop (connect + subscribe + await close -> reconnect) -----
async function mainLoop() {
  while (running) {
    try {
      const token = await fetchToken();
      if (!token) {
        console.log("[MAIN] token not found, retry in 3s");
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      pushLog({ type: "start_connect", url: WS_URL, token_present: true, channels: CHANNELS });
      console.log("[RUN] connecting to", WS_URL);

      ws = new WebSocket(WS_URL, { handshakeTimeout: 15000 });

      attachWsHandlers(ws);

      // wait for open or error
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("ws open timeout")), 15000);
        ws.once("open", () => { clearTimeout(to); resolve(); });
        ws.once("error", (e) => { clearTimeout(to); reject(e); });
      });

      // send connect payload
      try {
        const connectPayload = { id: 1, connect: { token, subs: {} } };
        ws.send(JSON.stringify(connectPayload));
        pushLog({ type: "connect_sent", summary: { id: 1 } });
        console.log("[WS->] CONNECT sent");
      } catch (e) {
        pushLog({ type: "connect_send_error", error: String(e) });
        console.error("[ERR] connect send failed", e);
      }

      // subscribe to channels but do not log pushes full (we'll ignore push bodies by default)
      await new Promise(r => setTimeout(r, 200));
      CHANNELS.forEach((ch, i) => {
        try {
          const payload = { id: 100 + i, subscribe: { channel: ch } };
          ws.send(JSON.stringify(payload));
          pushLog({ type: "subscribe_sent", channel: ch, id: payload.id });
          console.log("[WS->] subscribe", ch);
        } catch (e) {
          pushLog({ type: "subscribe_send_error", channel: ch, error: String(e) });
          console.error("[ERR] subscribe send failed", e);
        }
      });

      // wait for close/error (no autonomous reconnect here except when socket closes)
      await new Promise((resolve) => {
        const onEnd = () => resolve();
        ws.once("close", onEnd);
        ws.once("error", onEnd);
      });

      // socket closed -> reconnect with backoff
      reconnectAttempts++;
      const backoff = Math.min(30000, 2000 * Math.pow(1.5, reconnectAttempts));
      pushLog({ type: "reconnect_backoff", attempt: reconnectAttempts, backoff_ms: Math.round(backoff) });
      await new Promise(r => setTimeout(r, backoff));
    } catch (e) {
      pushLog({ type: "main_loop_exception", error: String(e) });
      console.error("[MAIN EXCEPTION]", e?.message || e);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ----- HTTP server: / , /logs , /status -----
const httpServer = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok\n");
  }
  if (req.url === "/logs") {
    // return last logs (limit by MAX_LOG_ENTRIES)
    const payload = {
      ts: nowIso(),
      last_count: logs.length,
      last: logs.slice(-MAX_LOG_ENTRIES)
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(payload));
  }
  if (req.url === "/status") {
    const connected = !!(ws && ws.readyState === WebSocket.OPEN);
    const sessionDurationMs = sessionStartTs ? (Date.now() - sessionStartTs) : 0;
    const payload = {
      ts: nowIso(),
      connected,
      channels: CHANNELS,
      session_start: sessionStartTs ? new Date(sessionStartTs).toISOString() : null,
      session_duration_ms: sessionDurationMs,
      session_duration_human: sessionDurationMs ? `${Math.round(sessionDurationMs/1000)}s` : null,
      last_pong_ts: lastPongTs ? new Date(lastPongTs).toISOString() : null,
      last_disconnect: lastDisconnect || null,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(payload));
  }
  res.writeHead(404); res.end("not found");
});

httpServer.listen(PORT, () => {
  pushLog({ type: "http_listen", port: PORT });
  console.log("[HTTP] listening", PORT);
});

// ----- Periodic tasks -----
setInterval(() => {
  // heartbeat log to keep Render aware & visibility that session is still active
  const connected = !!(ws && ws.readyState === WebSocket.OPEN);
  const sessionDurationMs = sessionStartTs ? (Date.now() - sessionStartTs) : 0;
  pushLog({ type: "heartbeat", connected, session_duration_ms: sessionDurationMs });
  // dump logs to file for artifact pickup
  try {
    if (logs.length) {
      const fn = path.join(os.tmpdir(), `ws_sniffer_dump_${Date.now()}.json`);
      fs.writeFileSync(fn, JSON.stringify({ exportedAt: nowIso(), entries: logs.length }, null, 2));
      pushLog({ type: "dump_saved", file: fn, entries: logs.length });
    }
  } catch (e) {
    pushLog({ type: "dump_err", error: String(e) });
  }
}, HEARTBEAT_LOG_INTERVAL_MS);

// periodic dump (separate)
setInterval(() => {
  try {
    if (logs.length) {
      const fn = path.join(os.tmpdir(), `ws_sniffer_auto_${Date.now()}.json`);
      fs.writeFileSync(fn, JSON.stringify({ exportedAt: nowIso(), logs }, null, 2));
      pushLog({ type: "periodic_dump_saved", file: fn, entries: logs.length });
    }
  } catch (e) {
    pushLog({ type: "periodic_dump_err", error: String(e) });
  }
}, DUMP_INTERVAL_MS);

// Graceful shutdown
process.on("SIGINT", () => {
  pushLog({ type: "shutdown", signal: "SIGINT" });
  running = false;
  try { if (ws) ws.close(); } catch {}
  process.exit(0);
});
process.on("SIGTERM", () => {
  pushLog({ type: "shutdown", signal: "SIGTERM" });
  running = false;
  try { if (ws) ws.close(); } catch {}
  process.exit(0);
});

// Start main loop
mainLoop().catch(e => {
  pushLog({ type: "fatal", error: String(e) });
  console.error("[FATAL]", e);
  process.exit(1);
});