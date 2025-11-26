// server.js (v4.5.0 - C-mode)
// Purpose: maximal transport + protocol visibility for debugging ping/pong.
// - Logs transport ping frames (hex + base64) and JSON ping/pong
// - Replies to transport ping with identical payload (ws.pong(data))
// - Replies to JSON ping with { pong: {} }
// - Subscribes to channels but does NOT dump push payloads (to avoid spam)
// - No DB writes
//
// ENV overrides:
//  WS_URL (default wss://ws.cs2run.app/connection/websocket)
//  ORIGIN (default https://csgoyz.run)
//  UA (user-agent string, optional)
//  CHANNELS (comma-separated list; defaults to "system:public,crash:public")

import WebSocket from "ws";
import fetch from "node-fetch";

const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const ORIGIN = process.env.ORIGIN || "https://csgoyz.run";
const UA = process.env.UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CHANNELS = (process.env.CHANNELS || "system:public,crash:public").split(",").map(s => s.trim()).filter(Boolean);

const RECONNECT_FORCE_MS = 5 * 60 * 1000; // periodic force reconnect
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

let ws = null;
let stopped = false;
let attempt = 0;
let periodicReconnect = null;
let backoffTimer = null;

// helpers
function iso() { return new Date().toISOString(); }
function log(...args){ console.log(iso(), ...args); }
function bufToHex(b){ if(!b) return ""; return Buffer.from(b).toString('hex'); }
function bufToBase64(b){ if(!b) return ""; return Buffer.from(b).toString('base64'); }

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

function safeClose(){
  try { if(ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch(e){}
}

async function startClient(){
  if (stopped) return;
  const token = await getToken();
  if (!token) {
    log("[START] token missing, retry in 3s");
    setTimeout(startClient, 3000);
    return;
  }

  const headers = { Origin: ORIGIN, "User-Agent": UA };

  log("[START] connecting...", WS_URL);
  ws = new WebSocket(WS_URL, { headers });

  let gotConnectAck = false;
  let lastTransportPingTs = 0;

  function schedulePeriodicReconnect(){
    if (periodicReconnect) clearTimeout(periodicReconnect);
    periodicReconnect = setTimeout(() => {
      log("[AUTO] forcing periodic reconnect");
      safeClose();
    }, RECONNECT_FORCE_MS);
  }

  ws.once("open", () => {
    attempt = 0;
    log("[WS] OPEN");
    // send connect JSON but do not send any pong proactively
    const connectMsg = { id: 1, connect: { token, subs: {} } };
    try {
      ws.send(JSON.stringify(connectMsg));
      log("[LOG] connect_sent client", { token_present: true });
    } catch(e){
      log("[ERR] send connect", e?.message || e);
    }
    schedulePeriodicReconnect();
  });

  // Transport-level ping (binary frame) — low-level
  ws.on("ping", (data) => {
    lastTransportPingTs = Date.now();
    const hex = bufToHex(data);
    const b64 = bufToBase64(data);
    log("[TRANSPORT] ping <- received", { hex_sample: hex.slice(0,128), base64_sample: b64.slice(0,256) });

    // Reply exactly same payload
    try {
      ws.pong(data);
      log("[TRANSPORT] pong -> sent (mirror)", { hex_sample: hex.slice(0,128) });
    } catch(e){
      log("[TRANSPORT] pong send error", e?.message || e);
    }
  });

  ws.on("pong", (data) => {
    lastTransportPingTs = Date.now();
    const hex = bufToHex(data);
    const b64 = bufToBase64(data);
    log("[TRANSPORT] pong <- event", { hex_sample: hex.slice(0,128), base64_sample: b64.slice(0,256) });
  });

  // Message event — can be JSON text or binary buffer
  ws.on("message", (raw) => {
    // detect buffer vs string
    if (raw instanceof Buffer) {
      // Binary envelope received: log sample (hex & base64)
      const hex = bufToHex(raw);
      const b64 = bufToBase64(raw);
      log("[MSG binary] raw binary frame (sample logged)", { hex_sample: hex.slice(0,256), base64_sample: b64.slice(0,512) });
      // Attempt to parse as UTF-8 JSON if possible
      let text;
      try { text = raw.toString('utf8'); } catch(e){ text = null; }
      if (!text) return;
      try {
        const m = JSON.parse(text);
        handleJsonMessage(m);
      } catch(e){
        // not JSON, we captured binary sample above
      }
      return;
    }

    // string
    let text = String(raw);
    // attempt JSON parse
    let msg = null;
    try { msg = JSON.parse(text); }
    catch {
      log("[MSG text] non-json text (sample)", text.slice(0,300));
      return;
    }
    handleJsonMessage(msg);
  });

  function handleJsonMessage(msg){
    const arr = Array.isArray(msg) ? msg : [msg];
    for (const m of arr){
      // JSON-level ping
      if (m.ping !== undefined) {
        log("[JSON] ping <- server", m.ping || {});
        // send JSON pong
        try {
          ws.send(JSON.stringify({ pong: {} }));
          log("[JSON] pong -> sent");
        } catch(e){
          log("[ERR] json pong send", e?.message || e);
        }
        continue;
      }

      // connect ack variants
      if ((m.id === 1 && m.connect) || (m.id === 1 && m.result && m.result.connect)) {
        if (!gotConnectAck) {
          gotConnectAck = true;
          const clientId = (m.connect && m.connect.client) || (m.result?.connect?.client) || null;
          log("[LOG] connect_ack server", { client: clientId });

          // Slight delay before subscribe to better mimic browser timing
          setTimeout(() => {
            CHANNELS.forEach((ch, idx) => {
              try {
                const sub = { id: 100 + idx, subscribe: { channel: ch } };
                ws.send(JSON.stringify(sub));
                log("[LOG] subscribe_sent client", { channel: ch, id: 100 + idx });
              } catch(e){
                log("[ERR] subscribe send", e?.message || e);
              }
            });
          }, 120);
        }
        continue;
      }

      // subscribe acks
      if (m.id === 100 || m.id === 101 || m.id >= 100) {
        log("[LOG] sub_ok server", { id: m.id });
        continue;
      }

      // ignore heavy push payloads (spam)
      if (m.push) {
        // We intentionally DO NOT log the push payload.
        // But log small metadata for channel visibility (no heavy content).
        try {
          const ch = m.push.channel || "(unknown)";
          log("[PUSH] ignored", { channel: ch });
        } catch(e){}
        continue;
      }

      // fallback: log small sample
      try {
        log("[MSG other] sample", JSON.stringify(m).slice(0,400));
      } catch(e){}
    }
  }

  ws.on("close", (code, reason) => {
    log("[CLOSE]", code, reason?.toString?.() || reason);
    if (periodicReconnect) { clearTimeout(periodicReconnect); periodicReconnect = null; }
    if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }

    // reconnect backoff
    attempt++;
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, Math.min(10, attempt)));
    log("[RECONNECT] attempt=", attempt, " backoff_ms=", backoff);
    backoffTimer = setTimeout(() => { startClient(); }, backoff);
  });

  ws.on("error", (err) => {
    log("[WS ERROR]", err?.message || err);
    try { if (ws) ws.close(); } catch(e){}
  });

  // Watchdog: if no transport ping for a long time -> force reconnect
  (function watchdog(){
    const id = setInterval(() => {
      if (!ws) return clearInterval(id);
      if (ws.readyState !== WebSocket.OPEN) return;
      const last = lastTransportPingTs || 0;
      const age = Date.now() - last;
      // if we never saw a transport ping within 75s, force reconnect (conservative)
      if (last === 0 && Date.now() - startTimeForWatchdog > 90_000) {
        log("[WATCHDOG] no transport ping observed in initial window — forcing reconnect");
        safeClose();
      } else if (last !== 0 && age > 90_000) {
        log("[WATCHDOG] last transport ping age ms:", age, " — forcing reconnect");
        safeClose();
      }
    }, 30_000);
    let startTimeForWatchdog = Date.now();
  })();
}

// start
startClient().catch(err => {
  console.error("[FATAL]", err);
  process.exit(1);
});

// graceful
process.on("SIGINT", () => { log("SIGINT, shutting"); stopped = true; safeClose(); setTimeout(()=>process.exit(0),500); });
process.on("SIGTERM", () => { log("SIGTERM, shutting"); stopped = true; safeClose(); setTimeout(()=>process.exit(0),500); });