// server.js v4.7.0 — STABLE-PONG
// Подписки: system:public, crash:public
// Авто-PONG (binary JSON { "type": 3 }) после connect_ack, интервал ~22s (джиттер).
// ENV:
//  WS_URL             - ws url (default: wss://ws.cs2run.app/connection/websocket)
//  ORIGIN             - Origin header (default: https://csgoyz.run)
//  UA                 - User-Agent header (optional)
//  CHANNELS           - comma list (default: "system:public,crash:public")
//  PONG_INTERVAL_MS   - base interval in ms (default: 22000)
//  PONG_JITTER_MS     - +/- jitter in ms (default: 500)
//  RESPOND_TRANS_PONG - "true" to reply ws.pong(data) to transport ping (default: false)
//  BINARY_DUMP_LIMIT  - bytes to sample from binary frame (default: 4096)

import WebSocket from "ws";
import fetch from "node-fetch";

const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const ORIGIN = process.env.ORIGIN || "https://csgoyz.run";
const UA = process.env.UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CHANNELS = (process.env.CHANNELS || "system:public,crash:public").split(",").map(s => s.trim()).filter(Boolean);

const PONG_INTERVAL_MS = Number(process.env.PONG_INTERVAL_MS || 22000);
const PONG_JITTER_MS = Number(process.env.PONG_JITTER_MS || 500);
const RESPOND_TRANS_PONG = String(process.env.RESPOND_TRANS_PONG || "false").toLowerCase() === "true";
const BINARY_DUMP_LIMIT = Number(process.env.BINARY_DUMP_LIMIT || 4096);

// reconnect policy
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

let ws = null;
let stopped = false;
let attempt = 0;
let pongTimer = null;
let lastConnectClientId = null;
let backoffTimer = null;

function iso(){ return new Date().toISOString(); }
function log(...a){ console.log(iso(), ...a); }
function bufHex(b){ return Buffer.isBuffer(b) ? b.toString('hex') : Buffer.from(b || "").toString('hex'); }
function bufB64(b){ return Buffer.isBuffer(b) ? b.toString('base64') : Buffer.from(b || "").toString('base64'); }

async function getToken(){
  try {
    const r = await fetch("https://cs2run.app/current-state", { cache: "no-store" });
    const j = await r.json();
    return j?.data?.main?.centrifugeToken || null;
  } catch (e) {
    log("[TOKEN] fetch error", e?.message || e);
    return null;
  }
}

function scheduleNextPong() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const jitter = Math.floor((Math.random() * (2 * PONG_JITTER_MS + 1)) - PONG_JITTER_MS);
  const delay = Math.max(1, PONG_INTERVAL_MS + jitter);
  if (pongTimer) clearTimeout(pongTimer);
  pongTimer = setTimeout(() => {
    sendBinaryPong();
    scheduleNextPong();
  }, delay);
  log("[PONG TIMER] next in ms:", delay);
}

function clearPongTimer(){
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
}

function sendBinaryPong() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("[PONG] cannot send, ws not open");
    return;
  }
  try {
    const obj = { type: 3 };
    const buf = Buffer.from(JSON.stringify(obj), "utf8");
    ws.send(buf, { binary: true });
    log("[PONG] binary JSON sent ->", JSON.stringify(obj));
  } catch (e) {
    log("[ERR] sending binary pong", e?.message || e);
  }
}

function safeClose(){
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch(e){}
}

async function startClient(){
  if (stopped) return;
  const token = await getToken();
  if (!token) {
    log("[START] token missing → retry in 3s");
    setTimeout(startClient, 3000);
    return;
  }

  const headers = { Origin: ORIGIN, "User-Agent": UA };

  log("[START] connecting...", WS_URL);
  ws = new WebSocket(WS_URL, { headers });

  let gotConnectAck = false;

  ws.once("open", () => {
    attempt = 0;
    log("[WS] OPEN");
    const connectMsg = { id: 1, connect: { token, subs: {} } };
    try {
      ws.send(JSON.stringify(connectMsg));
      log("[LOG] connect_sent client", { token_present: true });
    } catch(e){
      log("[ERR] send connect", e?.message || e);
    }
  });

  ws.on("ping", (data) => {
    const hex = bufHex(data);
    log("[TRANSPORT] ws PING opcode <-", { size: data?.length || 0, hex: hex.slice(0,512) });
    if (RESPOND_TRANS_PONG) {
      try {
        ws.pong(data);
        log("[TRANSPORT] ws PONG opcode -> sent (mirror)");
      } catch(e){ log("[ERR] ws.pong()", e?.message || e); }
    }
  });

  ws.on("pong", (data) => {
    const hex = bufHex(data);
    log("[TRANSPORT] ws PONG opcode <-", { size: data?.length || 0, hex: hex.slice(0,512) });
  });

  ws.on("message", (raw, isBinary) => {
    try {
      if (isBinary || Buffer.isBuffer(raw)) {
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const totalSize = buffer.length;
        const slice = buffer.slice(0, BINARY_DUMP_LIMIT);
        const truncated = totalSize > BINARY_DUMP_LIMIT;
        log("[MSG binary] frame received", { totalSize, truncated, dumpBytes: slice.length, hex_sample: slice.toString('hex').slice(0,1024), base64_sample: slice.toString('base64').slice(0,2048) });

        // attempt JSON decode (UTF-8)
        let text = null;
        try { text = buffer.toString('utf8'); } catch(e){}
        if (text !== null && text.length) {
          try {
            const parsed = JSON.parse(text);
            log("[MSG binary->JSON] parsed full JSON", JSON.stringify(parsed));
            handleJsonMessage(parsed);
            return;
          } catch (e) {
            // truncated or non-json — we already logged sample
            log("[MSG binary] not-JSON or truncated; sample logged");
            return;
          }
        } else {
          // non-text binary
          return;
        }
      } else {
        // text
        const text = String(raw);
        let parsed = null;
        try {
          parsed = JSON.parse(text);
          handleJsonMessage(parsed);
          return;
        } catch(e){
          log("[MSG text] non-json sample", text.slice(0,1000));
          return;
        }
      }
    } catch(e){
      log("[ERR] message handling", e?.message || e);
    }
  });

  function handleJsonMessage(msg){
    const arr = Array.isArray(msg) ? msg : [msg];
    for (const m of arr) {
      // If message contains "ping" property or type==2 (centrifugo style), log
      if (m.ping !== undefined || m.type === 2) {
        log("[JSON] PING <-", JSON.stringify(m));
        // We rely on our scheduled PONG (not reflexive), but we could respond here if needed.
        continue;
      }

      // connect ack detection: server sends connect object or result/id
      if ((m.id === 1 && m.connect) || (m.result && m.id === 1) || (m.connect && m.connect.client)) {
        if (!gotConnectAck) {
          gotConnectAck = true;
          lastConnectClientId = (m.connect && m.connect.client) || (m.result?.connect?.client) || null;
          log("[LOG] connect_ack server", { client: lastConnectClientId });
          // subscribe to channels
          setTimeout(() => {
            CHANNELS.forEach((ch, idx) => {
              try {
                const sub = { id: 100 + idx, subscribe: { channel: ch } };
                ws.send(JSON.stringify(sub));
                log("[LOG] subscribe_sent client", { channel: ch, id: 100 + idx });
              } catch(e){ log("[ERR] subscribe send", e?.message || e); }
            });
          }, 120);
          // start scheduled PONG cycle (allow initial window before first pong)
          // start with a first send slightly before server's typical drop (~22s)
          scheduleNextPong();
        }
        continue;
      }

      // subscribe ack
      if (typeof m.id === "number" && m.id >= 100) {
        log("[LOG] sub_ok server", { id: m.id });
        continue;
      }

      // large push payloads → ignore body but note channel
      if (m.push) {
        const ch = m.push.channel || "(unknown)";
        log("[PUSH] ignored (spam)", { channel: ch });
        continue;
      }

      // fallback: log sample
      try { log("[MSG other] sample", JSON.stringify(m).slice(0,400)); } catch(e){}
    }
  }

  ws.on("close", (code, reason) => {
    log("[CLOSE]", code, reason?.toString?.() || reason);
    clearPongTimer();
    if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }
    attempt++;
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, Math.min(10, attempt)));
    log("[RECONNECT] attempt=", attempt, " backoff_ms=", backoff);
    backoffTimer = setTimeout(() => { startClient(); }, backoff);
  });

  ws.on("error", (err) => {
    log("[WS ERROR]", err?.message || err);
    try { if (ws) ws.close(); } catch(e){}
  });
}

// start
startClient().catch(e => { console.error("[FATAL]", e); process.exit(1); });

// graceful
process.on("SIGINT", () => { log("SIGINT"); stopped = true; safeClose(); setTimeout(()=>process.exit(0),500); });
process.on("SIGTERM", () => { log("SIGTERM"); stopped = true; safeClose(); setTimeout(()=>process.exit(0),500); });