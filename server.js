/**
 * ws-sniffer-stable v4.8.0
 * Purpose: exhaustive binary/text ws sniffer + experimental raw-pong responder
 *
 * Usage:
 *   - set env vars as needed (see config section below)
 *   - npm install
 *   - node server.js
 *
 * Notes:
 *   - Этот код делает множественные попытки ответов pong'ом:
 *       1) ws.pong(raw) (transport-level)
 *       2) send(JSON.stringify({type:3}))
 *       3) send(rawBuffer derived from last incoming frame with conservative replacement)
 *   - Не обещаю 100% успеха против систем со сложной криптографической подпиской/шифрованием.
 */

import WebSocket from "ws";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import os from "os";
import express from "express";

const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const CHANNELS = (process.env.CHANNELS && process.env.CHANNELS.split(",")) || ["csgorun:crash", "csgorun:main"];
const DUMP_DIR = process.env.DUMP_DIR || "./dumps";
const MAX_STORED_FRAMES = Number(process.env.MAX_FRAMES || 200); // circular buffer
const LOG_SAMPLE_BYTES = Number(process.env.SAMPLE_BYTES || 256); // how many bytes to include in hex/base64 samples
const IGNORE_PUSH = (process.env.IGNORE_PUSH || "true") === "true"; // don't log game pushes by default
const RECONNECT_BASE_MS = Number(process.env.RECONNECT_BASE_MS || 2000);
const RECONNECT_MAX_MS = Number(process.env.RECONNECT_MAX_MS || 60000);

if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });

function nowISO(){ return new Date().toISOString(); }
function hex(buf){ return Buffer.from(buf).toString('hex'); }
function b64(buf){ return Buffer.from(buf).toString('base64'); }

let ws = null;
let reconnectDelay = RECONNECT_BASE_MS;
let lastFrames = []; // circular store { ts, raw, totalSize, hex_sample, base64_sample, parsedJSON? }
let currentLogStream = null;
let pongTimer = null;
let nextPongMs = null;
let clientTokenCache = null;

function openLogStream(){
  const file = path.join(DUMP_DIR, `ws-log-${new Date().toISOString().replace(/[:.]/g,'-')}.ndjson`);
  currentLogStream = fs.createWriteStream(file, { flags: 'a' });
  console.log(nowISO(), "[LOG->FILE] open", file);
  writeLog({ event: "start", ts: nowISO(), wsUrl: WS_URL, channels: CHANNELS });
}

function writeLog(obj){
  try {
    if (!currentLogStream) openLogStream();
    const line = JSON.stringify(Object.assign({ ts: nowISO() }, obj));
    currentLogStream.write(line + os.EOL);
  } catch (e) { console.error(nowISO(), "[ERR] writeLog", e && e.message); }
}

function pushFrame(rawBuf){
  const totalSize = rawBuf.length;
  const dumpBytes = Math.min(LOG_SAMPLE_BYTES, totalSize);
  const sampleBuf = rawBuf.slice(0, dumpBytes);
  const entry = {
    ts: Date.now(),
    totalSize,
    truncated: dumpBytes < totalSize,
    dumpBytes,
    hex_sample: sampleBuf.toString('hex'),
    base64_sample: sampleBuf.toString('base64'),
    raw: rawBuf // keep buffer in memory for potential replay; careful about memory: limited by MAX_STORED_FRAMES
  };
  lastFrames.push(entry);
  if (lastFrames.length > MAX_STORED_FRAMES) lastFrames.shift();
  // write log without raw buffer (too big) — keep samples
  const entryForLog = Object.assign({}, entry);
  delete entryForLog.raw;
  writeLog({ event: "frame_in", frame: entryForLog });
  return entry;
}

async function fetchToken(){
  // Try cache first (short-lived)
  if (clientTokenCache && (Date.now() - clientTokenCache._fetchedAt) < 30_000) return clientTokenCache.token;
  try {
    const r = await fetch("https://cs2run.app/current-state", { cache: "no-store" });
    const j = await r.json();
    const token = j?.data?.main?.centrifugeToken || null;
    clientTokenCache = { token, _fetchedAt: Date.now() };
    console.log(nowISO(), "[INFO] token fetched status:", token ? "FOUND" : "MISSING");
    return token;
  } catch (e){
    console.error(nowISO(), "[ERR] fetchToken", e && e.message);
    return null;
  }
}

function schedulePongInterval(intervalMs){
  if (pongTimer) clearTimeout(pongTimer);
  nextPongMs = intervalMs;
  pongTimer = setTimeout(() => {
    try {
      // if lastFrames contain candidate, try raw-pong first
      const last = lastFrames.length ? lastFrames[lastFrames.length-1] : null;
      if (last) {
        attemptRawPongFrom(last);
      }
      // fallback json pong
      tryJsonPong();
    } catch (e) { console.error(nowISO(), "[ERR] pongTimer", e && e.message); }
    // reschedule with a slight jitter (±1000ms)
    const jitter = Math.floor(Math.random() * 2000) - 1000;
    pongTimer = setTimeout(() => {}, Math.max(1000, nextPongMs + jitter));
  }, intervalMs);
  console.log(nowISO(), "[PONG TIMER] next in ms:", intervalMs);
}

function clearPongTimer(){
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; nextPongMs = null; }
}

/* -------- send helpers -------- */

function tryJsonPong(){
  if (!ws || ws.readyState !== ws.OPEN) return false;
  try {
    const payload = JSON.stringify({ type: 3 });
    ws.send(payload);
    console.log(nowISO(), "[PONG] JSON sent ->", payload);
    writeLog({ event: "pong_sent", method: "json", payload });
    return true;
  } catch (e) {
    console.error(nowISO(), "[ERR] tryJsonPong", e && e.message);
    return false;
  }
}

function tryTransportPong(data){
  // call ws.pong (transport-level) if supported by ws lib
  if (!ws || ws.readyState !== ws.OPEN) return false;
  try {
    ws.pong(data || Buffer.from([]));
    console.log(nowISO(), "[PONG] transport-level pong sent");
    writeLog({ event: "pong_sent", method: "transport", payloadLen: (data ? data.length : 0) });
    return true;
  } catch (e) {
    console.error(nowISO(), "[ERR] tryTransportPong", e && e.message);
    return false;
  }
}

function attemptRawPongFrom(frameEntry){
  if (!ws || ws.readyState !== ws.OPEN) return false;
  if (!frameEntry || !frameEntry.raw) return false;

  const buf = Buffer.from(frameEntry.raw); // copy
  let s = buf.toString('utf8');

  // conservative replacements:
  //  - if we see "\"ping\":<num>" replace with "\"type\":3"
  //  - else if we see "\"pong\":true" replace with "\"type\":3"
  //  - else if we see "\"connect\":{...}" try insert {"type":3} heuristically
  let replaced = false;
  // regex patterns
  const pingRe = /"ping"\s*:\s*\d+/;
  const pongTrueRe = /"pong"\s*:\s*true/;
  if (pingRe.test(s)) {
    s = s.replace(pingRe, '"type":3');
    replaced = true;
  } else if (pongTrueRe.test(s)) {
    s = s.replace(pongTrueRe, '"type":3');
    replaced = true;
  } else {
    // try to detect connect wrapper and create minimal raw reply
    // do NOT mutate original too aggressively - fallback later
    const connectRe = /"connect"\s*:\s*\{[^}]*\}/;
    if (connectRe.test(s)) {
      // create minimal: {"type":3}
      const raw = Buffer.from(JSON.stringify({ type: 3 }));
      try {
        ws.send(raw);
        console.log(nowISO(), "[PONG] raw minimal JSON buffer sent (fallback)");
        writeLog({ event: "pong_sent", method: "raw_minimal", base64: raw.toString('base64') });
        return true;
      } catch (e) {}
    }
  }

  if (!replaced) {
    // no safe replacement found; try transport-level pong and json pong then return
    tryTransportPong();
    tryJsonPong();
    return false;
  }

  // safety: ensure result is valid utf8 JSON
  try {
    JSON.parse(s);
  } catch (e) {
    // invalid JSON -> don't send corrupted frame
    console.log(nowISO(), "[PONG] attempted replacement produced invalid JSON; aborting raw-pong");
    return false;
  }

  // send buffer
  const out = Buffer.from(s, 'utf8');
  try {
    ws.send(out);
    console.log(nowISO(), "[PONG] raw-based sent -> hex_sample:", out.slice(0,64).toString('hex'));
    writeLog({ event: "pong_sent", method: "raw_based", hex_sample: out.slice(0,LOG_SAMPLE_BYTES).toString('hex'), base64_sample: out.slice(0,LOG_SAMPLE_BYTES).toString('base64') });
    return true;
  } catch (e) {
    console.error(nowISO(), "[ERR] attemptRawPongFrom.send", e && e.message);
    return false;
  }
}

/* -------- main ws logic -------- */

async function startWS(){
  const token = await fetchToken();
  if (!token) {
    console.log(nowISO(), "[WARN] token missing; retry in 3s");
    setTimeout(startWS, 3000);
    return;
  }

  openLogStream();
  console.log(nowISO(), "[START] connecting...", WS_URL);
  writeLog({ event: "start_connect", wsUrl: WS_URL });

  ws = new WebSocket(WS_URL, {
    // headers can be tuned if necessary
    headers: {
      // Origin can be used sometimes — leave commented for now
      // Origin: "https://csgoyz.run",
      // "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ..."
    }
  });

  ws.on('open', () => {
    reconnectDelay = RECONNECT_BASE_MS;
    console.log(nowISO(), "[WS] OPEN");
    writeLog({ event: "open" });

    // send centrifugo connect
    const connectMsg = { id: 1, connect: { token, subs: {} } };
    try {
      ws.send(JSON.stringify(connectMsg));
      console.log(nowISO(), "[LOG] connect_sent client", { token_present: !!token });
      writeLog({ event: "connect_sent", token_present: !!token, connectMsg });
    } catch (e){
      console.error(nowISO(), "[ERR] send connect", e && e.message);
    }

    // schedule a default heartbeat if we don't learn ping interval
    // will be replaced by value from connect_ack if provided (see message handler)
  });

  // 'ping' event (websocket-level)
  ws.on('ping', (data) => {
    console.log(nowISO(), "[WS] opcode: ping received, len=", data && data.length);
    writeLog({ event: "ws_ping", len: data ? data.length : 0, hex: data ? data.toString('hex') : null });
    // reply with transport-level pong
    tryTransportPong(data);
  });

  // 'pong' event (websocket-level)
  ws.on('pong', (data) => {
    console.log(nowISO(), "[WS] opcode: pong received, len=", data && data.length);
    writeLog({ event: "ws_pong", len: data ? data.length : 0 });
  });

  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary) {
        const buf = Buffer.from(data);
        const entry = pushFrame(buf);

        // try parse as JSON (safe)
        let parsed = null;
        try {
          parsed = JSON.parse(buf.toString('utf8'));
          writeLog({ event: "frame_parsed_json", parsed });
        } catch (e){ /* not JSON -> keep raw */ }

        // If parsed JSON contains connect + ping info -> schedule heartbeat with that interval
        if (parsed && parsed.connect && parsed.connect.ping) {
          const pingMs = (Number(parsed.connect.ping) || 25) * 1000;
          // schedule next pong somewhat earlier (reduce by 1000-3000ms)
          const sendIn = Math.max(1000, Math.floor(pingMs - 2000 + (Math.random()*800 - 400)));
          schedulePongInterval(sendIn);
          writeLog({ event: "connect_ack", client: parsed.connect.client, ping: parsed.connect.ping });
        }

        // If parsed JSON contains explicit "type":2 (server ping) -> respond immediately
        if (parsed && (parsed.type === 2 || parsed.ping !== undefined)) {
          writeLog({ event: "detected_server_ping", parsed });
          // reply transport-level + json + raw attempt
          tryTransportPong();
          tryJsonPong();
          attemptRawPongFrom(entry);
        }

        // If push messages — decide to ignore or log minimally
        if (parsed && parsed.push) {
          if (!IGNORE_PUSH) {
            writeLog({ event: "push", push: parsed.push });
            console.log(nowISO(), "[WS MSG push] channel", parsed.push.channel);
          } else {
            // log only a compact marker
            writeLog({ event: "push_ignored", channel: parsed.push.channel || null });
          }
        } else if (parsed) {
          // generic parsed JSON message (non-push)
          console.log(nowISO(), "[MSG binary->JSON] parsed full", parsed);
        } else {
          // raw binary + not JSON: dump short sample to console
          console.log(nowISO(), "[MSG binary] frame received { totalSize:", buf.length, ", hex_sample:", entry.hex_sample, "}");
        }
      } else {
        // text frame
        const txt = data.toString('utf8');
        writeLog({ event: "frame_text", text: txt.length > 1000 ? txt.slice(0,1000) + "..." : txt });
        let j = null;
        try { j = JSON.parse(txt); } catch {}
        if (j && j.ping !== undefined) {
          console.log(nowISO(), "[MSG JSON ping] ->", j);
          // immediate responses
          tryJsonPong();
        } else {
          console.log(nowISO(), "[MSG TEXT]", j || txt);
        }
      }
    } catch (e) {
      console.error(nowISO(), "[ERR] message handler", e && e.message);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(nowISO(), "[CLOSE]", code, reason && reason.toString ? reason.toString() : reason);
    writeLog({ event: "close", code, reason: reason && reason.toString ? reason.toString() : reason });
    clearPongTimer();
    // reconnect
    setTimeout(() => {
      reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 1.5);
      startWS();
    }, reconnectDelay);
  });

  ws.on('error', (err) => {
    console.error(nowISO(), "[WS ERROR]", err && (err.message || err.toString()));
    writeLog({ event: "error", message: err && (err.message || err.toString()) });
    // error will usually lead to close -> reconnection
  });

  // small helper: subscribe to safe channel list after open (delayed)
  const subscribeLater = () => {
    setTimeout(() => {
      try {
        CHANNELS.forEach((ch, idx) => {
          const id = 100 + idx;
          ws.send(JSON.stringify({ id, subscribe: { channel: ch } }));
          console.log(nowISO(), "[LOG] subscribe_sent client", { channel: ch, id });
          writeLog({ event: "subscribe_sent", channel: ch, id });
        });
      } catch (e) {
        console.error(nowISO(), "[ERR] subscribe", e && e.message);
      }
    }, 200);
  };
  // call subscribeLater shortly after open
  setTimeout(subscribeLater, 300);
}

const app = express();
app.get("/", (req,res)=>res.send("ok"));
const PORT = process.env.PORT || 8080;
app.listen(PORT, ()=> console.log("HTTP listen", PORT));

/* -------- CLI control / graceful shutdown -------- */

process.on('SIGINT', () => {
  console.log(nowISO(), "[SIGINT] Shutting down...");
  writeLog({ event: "shutdown" });
  if (currentLogStream) currentLogStream.end();
  try { if (ws) ws.close(); } catch {}
  process.exit(0);
});

/* start */
startWS();