// server.js — WS sniffer (Mode A: full raw wire dump)
// ES module style (node >= 18 / 20 / 22)
import WebSocket from "ws";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import os from "os";
import express from "express";

const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const CHANNELS = (process.env.CHANNELS || "csgorun:crash,csgorun:main").split(",");
const TOKEN_URL = process.env.TOKEN_URL || "https://cs2run.app/current-state";

const RECONNECT_BASE_MS = 2000;
const MAX_LOG_ENTRIES = Number(process.env.MAX_LOG_ENTRIES) || 20000;
const DUMP_INTERVAL_MS = Number(process.env.DUMP_INTERVAL_MS) || 120000; // 2 min
const STARTUP_LOG_TO_FILE = process.env.STARTUP_LOG_TO_FILE === "1" || false;

let ws = null;
let running = true;
let reconnectAttempts = 0;
let logs = []; // circular buffer of events

function pushLog(obj) {
  obj.ts = new Date().toISOString();
  logs.push(obj);
  if (logs.length > MAX_LOG_ENTRIES) logs.splice(0, logs.length - MAX_LOG_ENTRIES);
}

function hex(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf));
  return buf.toString("hex");
}
function b64(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf));
  return buf.toString("base64");
}

async function fetchToken() {
  try {
    const r = await fetch(TOKEN_URL, { cache: "no-store", timeout: 5000 });
    const j = await r.json();
    const token = j?.data?.main?.centrifugeToken;
    pushLog({ type: "token_fetch", ok: !!token });
    return token || null;
  } catch (e) {
    pushLog({ type: "token_fetch_error", error: String(e) });
    return null;
  }
}

function safeParseJsonMaybe(buf) {
  try {
    const txt = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

function dumpLogsToFile() {
  try {
    if (!logs.length) return;
    const fn = path.join(os.tmpdir(), `ws_dump_${Date.now()}.json`);
    fs.writeFileSync(fn, JSON.stringify({ exportedAt: new Date().toISOString(), logs }, null, 2));
    console.log("[DUMP] saved logs ->", fn, `(${logs.length} entries)`);
    pushLog({ type: "dump_saved", file: fn, entries: logs.length });
    // keep logs in memory; caller can pick up files from Render logs/artifacts if needed
  } catch (e) {
    console.error("[DUMP ERR]", e);
  }
}

function attachWsHandlers(wsInstance) {
  wsInstance.on("open", () => {
    reconnectAttempts = 0;
    pushLog({ type: "ws_open", url: WS_URL });
    console.log("[WS] OPEN");
  });

  // 'message' receives Buffer or string. We'll log raw bytes + try JSON parse.
  wsInstance.on("message", (data, isBinary) => {
    const entry = {
      type: "message",
      isBinary: !!isBinary,
      size: Buffer.isBuffer(data) ? data.length : String(data).length,
      hex: Buffer.isBuffer(data) ? data.toString("hex") : undefined,
      base64: Buffer.isBuffer(data) ? data.toString("base64") : undefined,
    };
    // if likely text, try parse JSON
    const parsed = safeParseJsonMaybe(data);
    if (parsed !== null) entry.parsed = parsed;
    pushLog(entry);

    // console output (compact)
    if (entry.isBinary) {
      console.log("[WS MSG BINARY] size=%d hex=%s", entry.size, entry.hex.slice(0, 120));
      if (parsed) console.log("[WS MSG JSON] ", parsed);
    } else {
      console.log("[WS MSG TEXT] ", typeof data === "string" ? data.slice(0, 160) : String(data).slice(0, 160));
      if (parsed) console.log("[WS MSG JSON] ", parsed);
    }
  });

  // low-level ping/pong frames (transport)
  wsInstance.on("ping", (data) => {
    pushLog({ type: "transport_ping", hex: hex(data), base64: b64(data) });
    console.log("[WS TRANSPORT PING] hex=", hex(data));
    // don't automatically pong here — let ws handle default? ws library replies automatically to ping if we call ws.pong
    // we'll also log and optionally respond
    try { wsInstance.pong(data); pushLog({ type: "transport_pong_sent", hex: hex(data) }); console.log("[WS TRANSPORT PONG] sent"); } catch(e){ console.warn("[WS TRANSPORT PONG ERR]", e.message); }
  });

  wsInstance.on("pong", (data) => {
    pushLog({ type: "transport_pong", hex: hex(data), base64: b64(data) });
    console.log("[WS TRANSPORT PONG RECV] hex=", hex(data));
  });

  wsInstance.on("close", (code, reason) => {
    const reasonStr = reason && reason.length ? reason.toString() : "";
    pushLog({ type: "ws_close", code, reason: reasonStr });
    console.log(`[WS] CLOSE code=${code} reason=${reasonStr}`);
    // will trigger reconnect by outer logic
  });

  wsInstance.on("error", (err) => {
    pushLog({ type: "ws_error", error: String(err) });
    console.error("[WS] ERROR", err?.message || err);
  });
}

async function start() {
  while (running) {
    try {
      const token = await fetchToken();
      if (!token) {
        console.log("[START] no token, retry in 3s");
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      console.log(`[START] connecting... ${WS_URL}`);
      pushLog({ type: "start_connect", url: WS_URL, token_present: !!token });

      ws = new WebSocket(WS_URL);

      attachWsHandlers(ws);

      // after open, do the usual Centrifugo-style connect and subscribe
      const onceOpen = new Promise((resolve) => {
        ws.once("open", () => resolve());
      });

      await onceOpen;

      // send connect (JSON) — keep same shape as browser client
      try {
        const connectPayload = {
          id: 1,
          connect: { token, subs: {} }
        };
        ws.send(JSON.stringify(connectPayload));
        pushLog({ type: "connect_sent", payload: connectPayload });
        console.log("[WS->] CONNECT sent");
      } catch (e) {
        pushLog({ type: "connect_send_error", error: String(e) });
        console.error("[ERR] connect send failed", e);
      }

      // small delay then subscribe to channels
      await new Promise((r) => setTimeout(r, 200));
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

      // wait until socket closes — we will detect close and loop to reconnect
      await new Promise((resolve) => {
        ws.once("close", () => resolve());
        ws.once("error", () => resolve());
      });

      // If we reach here, socket closed — loop and reconnect with backoff
      reconnectAttempts++;
      const backoff = Math.min(30000, RECONNECT_BASE_MS * Math.pow(1.5, reconnectAttempts));
      console.log(`[RECONNECT] attempt=${reconnectAttempts} backoff=${Math.round(backoff)}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    } catch (e) {
      pushLog({ type: "main_loop_error", error: String(e) });
      console.error("[MAIN ERR]", e);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// Periodic dump of logs to file
setInterval(() => {
  try {
    dumpLogsToFile();
  } catch (e) {
    console.error("[DUMP ERR]", e);
  }
}, DUMP_INTERVAL_MS);

// graceful shutdown
process.on("SIGINT", () => {
  console.log("SIGINT -> stopping");
  running = false;
  try { if (ws) ws.close(); } catch (e) {}
  dumpLogsToFile();
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("SIGTERM -> stopping");
  running = false;
  try { if (ws) ws.close(); } catch (e) {}
  dumpLogsToFile();
  process.exit(0);
});

// simple HTTP health endpoint for Render
const app = express();
app.get("/", (req, res) => res.send("ok"));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("HTTP listen", PORT));

// Start main loop
if (STARTUP_LOG_TO_FILE) dumpLogsToFile();
start().catch((e) => {
  console.error("[FATAL]", e);
  dumpLogsToFile();
  process.exit(1);
});