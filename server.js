// server.js — WS sniffer (reactive PONG by default, full decoding + push-filtering)
// Node >= 18 recommended. Uses ESM imports.
import WebSocket from "ws";
import fetch from "node-fetch";
import express from "express";

const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const TOKEN_URL = process.env.TOKEN_URL || "https://cs2run.app/current-state";
const CHANNELS = (process.env.CHANNELS || "system:public").split(",").map(s => s.trim()).filter(Boolean);

// LOGGING / DUMP
const MAX_LOG_ENTRIES = Number(process.env.MAX_LOG_ENTRIES) || 20000;
const DUMP_INTERVAL_MS = Number(process.env.DUMP_INTERVAL_MS) || 120000; // not used for DB here, only optional file dump
const OUTPUT_FULL = true; // console always prints
let circularLogs = [];

// PONG behavior
// REACTIVE_PONG = "1" или "true" — отвечаем только на приходящие ping/centrifugo ping messages.
// If PERIODIC_PONG_ENABLED=1 then additionally start periodic binary JSON PONG (useful if server expects it).
const REACTIVE_PONG = (process.env.REACTIVE_PONG ?? "1") === "1" || (process.env.REACTIVE_PONG ?? "true") === "true";
const PERIODIC_PONG_ENABLED = (process.env.PERIODIC_PONG_ENABLED ?? "0") === "1";
const PERIODIC_PONG_MS = Number(process.env.PERIODIC_PONG_MS) || 22000; // ~22s default

// Helpers
function pushLog(o){
  o.ts = new Date().toISOString();
  circularLogs.push(o);
  if (circularLogs.length > MAX_LOG_ENTRIES) circularLogs.splice(0, circularLogs.length - MAX_LOG_ENTRIES);
}
function hex(buf){ if (!buf) return null; return Buffer.isBuffer(buf) ? buf.toString("hex") : Buffer.from(String(buf)).toString("hex"); }
function b64(buf){ if (!buf) return null; return Buffer.isBuffer(buf) ? buf.toString("base64") : Buffer.from(String(buf)).toString("base64"); }
function safeParseJson(buf){
  try {
    const txt = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
    return JSON.parse(txt);
  } catch(e){
    return null;
  }
}
function dumpLogsToStdout(){
  console.log("[DUMP] logs entries:", circularLogs.length);
  // do not print full buffer by default to avoid spam; user can fetch via render logs
  pushLog({ type: "dump_stdout", count: circularLogs.length });
}

// Binary JSON PONG payload (some clients observed {"type":3})
function makeBinaryJsonPong(){
  // Keep as Buffer so ws sends as binary frame.
  return Buffer.from(JSON.stringify({ type: 3 }));
}

// Main WS client logic
let ws = null;
let periodicPongTimer = null;

async function fetchToken(){
  try {
    const res = await fetch(TOKEN_URL, { cache: "no-store" });
    const j = await res.json();
    const token = j?.data?.main?.centrifugeToken;
    pushLog({ type: "token_fetch", ok: !!token });
    return token || null;
  } catch (e) {
    pushLog({ type: "token_fetch_error", error: String(e) });
    return null;
  }
}

function clearPeriodicPong(){
  if (periodicPongTimer) { clearInterval(periodicPongTimer); periodicPongTimer = null; }
}

function startPeriodicPongIfNeeded(sendBinaryPongFn){
  clearPeriodicPong();
  if (PERIODIC_PONG_ENABLED) {
    periodicPongTimer = setInterval(() => {
      try {
        sendBinaryPongFn();
        pushLog({ type: "periodic_binary_pong_sent" });
      } catch(e){
        pushLog({ type: "periodic_pong_err", error: String(e) });
      }
    }, PERIODIC_PONG_MS);
    pushLog({ type: "periodic_pong_started", ms: PERIODIC_PONG_MS });
  }
}

function attachWsHandlers(wsInstance, sendBinaryPongFn) {
  wsInstance.on("open", () => {
    pushLog({ type: "ws_open", url: WS_URL });
    console.log("[WS] OPEN");
  });

  // low-level transport pings/pongs handled here
  wsInstance.on("ping", (data) => {
    pushLog({ type: "transport_ping", hex: hex(data), base64: b64(data) });
    console.log("[TRANSPORT] ping received hex=", hex(data)?.slice(0,80));
    try {
      // always respond with transport pong
      wsInstance.pong(data);
      pushLog({ type: "transport_pong_sent", hex: hex(data) });
      console.log("[TRANSPORT] pong (frame) sent");
      // Also send binary JSON PONG if configured reactive -> treat transport ping as trigger
      if (REACTIVE_PONG) {
        sendBinaryPongFn();
        pushLog({ type: "binary_pong_sent_on_transport_ping" });
      }
    } catch (e) {
      pushLog({ type: "transport_pong_error", error: String(e) });
    }
  });

  wsInstance.on("pong", (data) => {
    pushLog({ type: "transport_pong_received", hex: hex(data), base64: b64(data) });
    console.log("[TRANSPORT] pong received hex=", hex(data)?.slice(0,80));
  });

  wsInstance.on("message", (data, isBinary) => {
    const entry = {
      type: "message",
      isBinary: !!isBinary,
      size: Buffer.isBuffer(data) ? data.length : String(data).length,
      hex: Buffer.isBuffer(data) ? Buffer.from(data).toString("hex") : undefined,
      base64: Buffer.isBuffer(data) ? Buffer.from(data).toString("base64") : undefined,
    };

    // Try parse JSON (works for binary frames that actually contain JSON text)
    const parsed = safeParseJson(data);
    if (parsed !== null) entry.parsed = parsed;

    // Smart filtering: if message is a Centrifugo "push" (huge spam), do not print full push body
    if (entry.parsed && entry.parsed.push) {
      // log only channel / type
      const ch = entry.parsed.push.channel || "<unknown>";
      pushLog({ type: "push_received", channel: ch });
      console.log(`[WS MSG] push -> channel=${ch} (body suppressed)`);
      return;
    }

    // If it's a Centrifugo ping object: {"ping": ...}
    if (entry.parsed && entry.parsed.ping !== undefined) {
      pushLog({ type: "centrifugo_ping", value: entry.parsed.ping });
      console.log("[WS MSG] centrifugo PING ->", entry.parsed);

      // Send Centrifugo-style JSON PONG: { "pong": {} }
      try {
        wsInstance.send(JSON.stringify({ pong: {} }));
        pushLog({ type: "centrifugo_pong_sent" });
        console.log("[WS->] centrifugo JSON PONG sent");
      } catch (e){
        pushLog({ type: "centrifugo_pong_error", error: String(e) });
      }

      // Optionally also send binary JSON PONG if reactive mode (treat centrifugo ping as trigger)
      if (REACTIVE_PONG) {
        try {
          sendBinaryPongFn();
          pushLog({ type: "binary_pong_sent_on_centrifugo_ping" });
        } catch(e){
          pushLog({ type: "binary_pong_error", error: String(e) });
        }
      }
      return;
    }

    // If parsed JSON contains connect ack (id === 1 && result maybe) -> we consider connection stable and may start periodic PONG if enabled
    if (entry.parsed && ((entry.parsed.result && entry.parsed.id === 1) || (entry.parsed.id === 1 && entry.parsed.connect))) {
      pushLog({ type: "connect_ack_or_info", parsed: entry.parsed });
      console.log("[WS MSG] connect ack/info:", entry.parsed);
      // start periodic pong only if configured
      startPeriodicPongIfNeeded(sendBinaryPongFn);
      return;
    }

    // Generic logging for other messages
    pushLog({ type: "message_logged", parsed: entry.parsed ?? null, rawHex: entry.hex ? entry.hex.slice(0,200) : null });
    if (entry.parsed) {
      console.log("[WS MSG JSON]", entry.parsed);
    } else {
      if (entry.isBinary) {
        console.log("[WS MSG BINARY] size=%d hex=%s", entry.size, (entry.hex || "").slice(0,200));
      } else {
        console.log("[WS MSG TEXT]", String(data).slice(0,400));
      }
    }
  });

  wsInstance.on("close", (code, reason) => {
    const reasonStr = reason && reason.length ? reason.toString() : "";
    pushLog({ type: "ws_close", code, reason: reasonStr });
    console.log(`[WS] CLOSE code=${code} reason=${reasonStr}`);
    clearPeriodicPong();
  });

  wsInstance.on("error", (err) => {
    pushLog({ type: "ws_error", error: String(err) });
    console.error("[WS] ERROR", err?.message || err);
    clearPeriodicPong();
  });
}

async function runOnce() {
  const token = await fetchToken();
  if (!token) {
    console.log("[RUN] token missing — will retry in 3s");
    await new Promise(r => setTimeout(r, 3000));
    return;
  }

  console.log("[RUN] connecting to", WS_URL);
  pushLog({ type: "start_connect", url: WS_URL, token_present: !!token });

  ws = new WebSocket(WS_URL);

  // helper to send binary JSON PONG
  function sendBinaryPong(){
    try {
      const buf = makeBinaryJsonPong();
      // send as binary frame
      ws.send(buf, { binary: true }, (err) => {
        if (err) pushLog({ type: "binary_pong_send_err", error: String(err) });
      });
      console.log("[PONG] binary JSON sent ->", buf.toString());
      pushLog({ type: "binary_pong_sent", sample: buf.toString() });
    } catch(e){
      pushLog({ type: "binary_pong_error", error: String(e) });
    }
  }

  attachWsHandlers(ws, sendBinaryPong);

  // wait for open
  await new Promise((resolve) => ws.once("open", resolve));

  // send Centrifugo-style connect object (mirror browser)
  try {
    const o = { id: 1, connect: { token, subs: {} } };
    ws.send(JSON.stringify(o));
    pushLog({ type: "connect_sent", payload: o });
    console.log("[WS->] CONNECT sent");
  } catch (e) {
    pushLog({ type: "connect_send_error", error: String(e) });
  }

  // slight delay then subscribe
  await new Promise(r => setTimeout(r, 200));
  CHANNELS.forEach((ch, i) => {
    try {
      const payload = { id: 100 + i, subscribe: { channel: ch } };
      ws.send(JSON.stringify(payload));
      pushLog({ type: "subscribe_sent", channel: ch, id: payload.id });
      console.log("[WS->] subscribe", ch);
    } catch (e) {
      pushLog({ type: "subscribe_send_error", channel: ch, error: String(e) });
    }
  });

  // wait until close or error
  await new Promise((resolve) => {
    ws.once("close", resolve);
    ws.once("error", resolve);
  });

  // will return and allow outer loop to reconnect
}

let running = true;
async function mainLoop(){
  let backoff = 1000;
  while (running) {
    try {
      await runOnce();
      // on disconnect backoff
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(30000, backoff * 1.5);
    } catch (e) {
      pushLog({ type: "main_error", error: String(e) });
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// small periodic console dump to indicate alive
setInterval(() => {
  console.log("[HEARTBEAT]", new Date().toISOString(), "logs:", circularLogs.length);
}, 60000);

// HTTP health endpoint (Render)
const app = express();
app.get("/", (req, res) => res.send("ok"));
app.get("/logs", (req, res) => res.json({ exportedAt: new Date().toISOString(), entries: circularLogs.length }));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("[HTTP] listening", PORT));

// start main loop
mainLoop().catch(e => {
  console.error("[FATAL]", e);
  process.exit(1);
});