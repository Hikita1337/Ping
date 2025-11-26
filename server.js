// server.js — WS sniffer (full raw + JSON pong on server `{}` + optional periodic pong)
// ES module (Node 18+ / 20 / 22)
import WebSocket from "ws";
import fs from "fs";
import os from "os";
import path from "path";
import process from "process";
import http from "http";

// Configuration via ENV
const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const CHANNELS = (process.env.CHANNELS || "csgorun:crash,csgorun:main").split(",").map(s => s.trim()).filter(Boolean);
const TOKEN_URL = process.env.TOKEN_URL || "https://cs2run.app/current-state";

const PORT = Number(process.env.PORT || 10000); // Render free default open port
const LOG_PUSH_FULL = process.env.LOG_PUSH_FULL === "1" || false; // if true — log full push payloads (spammy)
const SEND_PERIODIC_PONG = process.env.SEND_PERIODIC_PONG === "1" || false; // default off (avoid shooting blindly)
const PERIODIC_PONG_MS = Number(process.env.PERIODIC_PONG_MS || 22000); // if periodic pong enabled
const MAX_LOG_ENTRIES = Number(process.env.MAX_LOG_ENTRIES || 40000);
const DUMP_INTERVAL_MS = Number(process.env.DUMP_INTERVAL_MS || 2 * 60 * 1000); // dump every 2 minutes
const RECONNECT_BASE_MS = 2000;

let ws = null;
let running = true;
let reconnectAttempts = 0;
let logs = []; // circular buffer
let periodicPongTimer = null;

// Simple logger that pushes to circular buffer + console
function pushLog(entry) {
  entry.ts = (new Date()).toISOString();
  logs.push(entry);
  if (logs.length > MAX_LOG_ENTRIES) logs.splice(0, logs.length - MAX_LOG_ENTRIES);
  // Console friendly printing
  const short = { ...entry };
  if (short.raw && short.raw.hex) short.raw.hex = short.raw.hex.slice(0, 120) + (short.raw.hex.length > 120 ? "..." : "");
  console.log(JSON.stringify(short));
}

function hex(buf) {
  if (!buf) return "";
  return Buffer.isBuffer(buf) ? buf.toString("hex") : Buffer.from(String(buf)).toString("hex");
}
function b64(buf) {
  if (!buf) return "";
  return Buffer.isBuffer(buf) ? buf.toString("base64") : Buffer.from(String(buf)).toString("base64");
}

async function fetchToken() {
  try {
    // Node has global fetch in modern runtimes
    const r = await fetch(TOKEN_URL, { cache: "no-store" });
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
  } catch {
    return null;
  }
}

function dumpLogsToFile() {
  if (!logs.length) {
    console.log("[DUMP] no logs to save");
    return;
  }
  try {
    const fn = path.join(os.tmpdir(), `ws_sniffer_dump_${Date.now()}.json`);
    fs.writeFileSync(fn, JSON.stringify({ exportedAt: new Date().toISOString(), logs }, null, 2));
    console.log("[DUMP] saved logs ->", fn, `(${logs.length} entries)`);
    pushLog({ type: "dump_saved", file: fn, entries: logs.length });
    // keep logs in memory (we do not clear intentionally)
  } catch (e) {
    console.error("[DUMP ERR]", e);
  }
}

// Prepare a binary JSON PONG buffer: {"type":3}
function makeBinaryJsonPong() {
  return Buffer.from(JSON.stringify({ type: 3 }));
}

// Attach handlers for a given WebSocket instance
function attachWsHandlers(wsInstance) {
  wsInstance.on("open", () => {
    reconnectAttempts = 0;
    pushLog({ type: "ws_open", url: WS_URL });
    console.log("[WS] OPEN");
  });

  wsInstance.on("message", (data, isBinary) => {
    // record raw
    const rawEntry = {
      type: "raw_msg",
      isBinary: !!isBinary,
      size: Buffer.isBuffer(data) ? data.length : String(data).length,
      raw: {
        hex: Buffer.isBuffer(data) ? data.toString("hex") : undefined,
        base64: Buffer.isBuffer(data) ? data.toString("base64") : undefined,
        text: (!Buffer.isBuffer(data) && typeof data === "string") ? data.slice(0, 2000) : undefined
      }
    };

    // try parse JSON
    const parsed = safeParseJsonMaybe(data);
    if (parsed !== null) rawEntry.parsed = parsed;

    pushLog(rawEntry);

    // Console-friendly handling & behavior
    if (parsed !== null) {
      // Centrifugo-style server ping often comes as empty object {}
      const isEmptyObject = (typeof parsed === "object" && parsed !== null && Object.keys(parsed).length === 0);
      if (isEmptyObject) {
        pushLog({ type: "server_ping_detected", note: "empty JSON frame {} received" });
        // Respond immediately with binary JSON pong
        try {
          const pongBuf = makeBinaryJsonPong();
          wsInstance.send(pongBuf, { binary: true }, (err) => {
            if (err) pushLog({ type: "send_error", error: String(err) });
            else pushLog({ type: "json_pong_sent", detail: { reason: "server_empty_json", hex: pongBuf.toString("hex") } });
          });
          console.log("[PONG] binary JSON sent ->", pongBuf.toString());
        } catch (e) {
          pushLog({ type: "pong_send_err", error: String(e) });
        }
        return;
      }

      // If it's connect ack/info (id:1 connect:{...})
      if (parsed.connect && parsed.id === 1) {
        pushLog({ type: "connect_ack", client: parsed.connect.client || null, meta: parsed.connect });
        console.log("[WS MSG] connect ack/info:", parsed.connect);
        // If periodic pong mode enabled -> start periodic timer AFTER connect ack
        if (SEND_PERIODIC_PONG) {
          if (periodicPongTimer) clearInterval(periodicPongTimer);
          // jitter +/- 800 ms to mimic browser
          const jitter = Math.floor(Math.random() * 1600) - 800;
          const interval = Math.max(1000, PERIODIC_PONG_MS + jitter);
          periodicPongTimer = setInterval(() => {
            try {
              const b = makeBinaryJsonPong();
              wsInstance.send(b, { binary: true }, (err) => {
                if (err) pushLog({ type: "periodic_pong_error", error: String(err) });
                else pushLog({ type: "periodic_pong_sent", hex: b.toString("hex") });
              });
              console.log("[PERIODIC PONG] sent");
            } catch (e) {
              pushLog({ type: "periodic_pong_exception", error: String(e) });
            }
          }, interval);
          pushLog({ type: "periodic_pong_started", intervalMs: interval });
        }
        return;
      }

      // Subscription ack/result messages
      if (parsed.id && String(parsed.id).startsWith("1")) {
        // don't spam, just acknowledge
        pushLog({ type: "msg_with_id", id: parsed.id, raw: parsed });
        console.log("[WS MSG ID]", parsed.id);
        return;
      }

      // push messages (game updates) are extremely spammy: filter them unless user asked to log full
      if (parsed.push) {
        const ch = parsed.push.channel || "(unknown)";
        if (LOG_PUSH_FULL) {
          pushLog({ type: "push_full", channel: ch, payload: parsed.push.pub });
          console.log("[WS PUSH]", ch, parsed.push.pub);
        } else {
          pushLog({ type: "push_ignored", channel: ch });
          console.log("[WS PUSH IGNORED]", ch);
        }
        return;
      }

      // Other structured messages — log
      pushLog({ type: "message_parsed", content: parsed });
      console.log("[WS MSG PARSED]", parsed);
      return;
    }

    // If not JSON-parsable: leave raw dump (hex/base64 already stored)
    pushLog({ type: "message_nonjson", note: "non-json payload received" });
    console.log("[WS MSG NON-JSON] size=", rawEntry.size);
  });

  // Transport-level ping/pong events
  wsInstance.on("ping", (data) => {
    pushLog({ type: "transport_ping", hex: hex(data), base64: b64(data) });
    console.log("[TRANSPORT PING] hex=", hex(data));
    // reply transport-level pong immediately
    try {
      wsInstance.pong(data);
      pushLog({ type: "transport_pong_sent", hex: hex(data) });
      console.log("[TRANSPORT PONG] sent");
    } catch (e) {
      pushLog({ type: "transport_pong_err", error: String(e) });
    }
  });

  wsInstance.on("pong", (data) => {
    pushLog({ type: "transport_pong_recv", hex: hex(data), base64: b64(data) });
    console.log("[TRANSPORT PONG RECV] hex=", hex(data));
  });

  wsInstance.on("close", (code, reason) => {
    const rs = (reason && reason.length) ? reason.toString() : "";
    pushLog({ type: "ws_close", code, reason: rs });
    console.log(`[WS] CLOSE code=${code} reason=${rs}`);
    // stop periodic timer
    if (periodicPongTimer) {
      clearInterval(periodicPongTimer);
      periodicPongTimer = null;
      pushLog({ type: "periodic_pong_stopped" });
    }
  });

  wsInstance.on("error", (err) => {
    pushLog({ type: "ws_error", error: String(err) });
    console.error("[WS ERROR]", err?.message || err);
  });
}

// Main loop: connect -> handshake -> subscribe -> wait for close -> reconnect
async function mainLoop() {
  while (running) {
    try {
      // fetch token (if fails retry)
      const token = await fetchToken();
      if (!token) {
        console.log("[MAIN] token not found, retry in 3s");
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      pushLog({ type: "start_connect", url: WS_URL, token_present: true });
      console.log("[RUN] connecting to", WS_URL);

      ws = new WebSocket(WS_URL);

      attachWsHandlers(ws);

      // wait for open
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("ws open timeout")), 15000);
        ws.once("open", () => { clearTimeout(to); resolve(); });
        ws.once("error", (e) => { clearTimeout(to); reject(e); });
      });

      // After open -> send connect payload as browser does
      try {
        const connectPayload = { id: 1, connect: { token, subs: {} } };
        ws.send(JSON.stringify(connectPayload));
        pushLog({ type: "connect_sent", payloadSummary: { id: 1 } });
        console.log("[WS->] CONNECT sent");
      } catch (e) {
        pushLog({ type: "connect_send_error", error: String(e) });
        console.error("[ERR] connect send failed", e);
      }

      // small delay then subscribe to channels (we'll log only subscribe attempt; server may reply unknown channel)
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

      // Wait until close/error
      await new Promise((resolve) => {
        const onClose = () => resolve();
        ws.once("close", onClose);
        ws.once("error", onClose);
      });

      // If closed, backoff and reconnect
      reconnectAttempts++;
      const backoff = Math.min(30000, RECONNECT_BASE_MS * Math.pow(1.5, reconnectAttempts));
      console.log(`[RECONNECT] attempt=${reconnectAttempts} backoff=${Math.round(backoff)}ms`);
      await new Promise(r => setTimeout(r, backoff));
    } catch (e) {
      pushLog({ type: "main_loop_exception", error: String(e) });
      console.error("[MAIN EXCEPTION]", e?.message || e);
      await new Promise(r => setTimeout(r, RECONNECT_BASE_MS));
    }
  }
}

// HTTP health endpoint (and endpoint to dump logs quickly)
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok\n");
  }
  if (req.url === "/logs") {
    // return last N logs as JSON
    const payload = { ts: new Date().toISOString(), last: logs.slice(-1000) };
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(payload));
  }
  // other
  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => console.log("[HTTP] listening", PORT));

// Periodic dump to file (for Render artifact pickup)
setInterval(() => {
  dumpLogsToFile();
}, DUMP_INTERVAL_MS);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("SIGINT -> stopping");
  running = false;
  try { if (ws) ws.close(); } catch {}
  dumpLogsToFile();
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("SIGTERM -> stopping");
  running = false;
  try { if (ws) ws.close(); } catch {}
  dumpLogsToFile();
  process.exit(0);
});

// Start
mainLoop().catch(e => { console.error("[FATAL]", e); dumpLogsToFile(); process.exit(1); });