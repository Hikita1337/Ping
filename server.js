// server.js (v4.6.0)
// Цель: пассивный сниффер transport+protocol с полным дампом фреймов (до лимита).
// По умолчанию НЕ отвечает pong'ами — только логирует. Отправка pong доступна через ENV.
//
// ENV:
//  WS_URL            - адрес WS (по умолчанию wss://ws.cs2run.app/connection/websocket)
//  ORIGIN            - Origin header (по умолчанию https://csgoyz.run)
//  UA                - User-Agent (опционально)
//  CHANNELS          - comma-separated list (по умолчанию "system:public,crash:public")
//  RESPOND_JSON_PONG - "true" чтобы отвечать JSON { pong: {} } на JSON ping (по умолчанию false)
//  RESPOND_TRANS_PONG- "true" чтобы отвечать transport-level pong (ws.pong(data)) при получении ws ping (по умолчанию false)
//  BINARY_DUMP_LIMIT - количество байт дампа бинарного кадра (по умолчанию 4096)

import WebSocket from "ws";
import fetch from "node-fetch";

const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const ORIGIN = process.env.ORIGIN || "https://csgoyz.run";
const UA = process.env.UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CHANNELS = (process.env.CHANNELS || "system:public,crash:public").split(",").map(s => s.trim()).filter(Boolean);

const RESPOND_JSON_PONG = String(process.env.RESPOND_JSON_PONG || "false").toLowerCase() === "true";
const RESPOND_TRANS_PONG = String(process.env.RESPOND_TRANS_PONG || "false").toLowerCase() === "true";
const BINARY_DUMP_LIMIT = Number(process.env.BINARY_DUMP_LIMIT || 4096);

// reconnect params (exponential backoff)
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

let ws = null;
let stopped = false;
let attempt = 0;
let backoffTimer = null;

function iso(){ return new Date().toISOString(); }
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
    log("[START] token missing → retry 3s");
    setTimeout(startClient, 3000);
    return;
  }

  const headers = { Origin: ORIGIN, "User-Agent": UA };

  log("[START] connecting...", WS_URL);
  ws = new WebSocket(WS_URL, { headers });

  let gotConnectAck = false;
  let lastTransportPingTs = 0;

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

  // transport ping event (WebSocket ping opcode)
  ws.on("ping", (data) => {
    lastTransportPingTs = Date.now();
    const hex = bufToHex(data);
    const b64 = bufToBase64(data);
    log("[TRANSPORT] ws PING (opcode) <-", { size: data?.length || 0, hex: hex.slice(0,512), base64: b64.slice(0,512) });
    if (RESPOND_TRANS_PONG) {
      try {
        ws.pong(data);
        log("[TRANSPORT] ws PONG (opcode) -> sent (mirror)");
      } catch(e){
        log("[ERR] ws.pong error", e?.message || e);
      }
    }
  });

  ws.on("pong", (data) => {
    lastTransportPingTs = Date.now();
    const hex = bufToHex(data);
    log("[TRANSPORT] ws PONG (opcode) <-", { size: data?.length || 0, hex: hex.slice(0,512) });
  });

  ws.on("message", (raw, isBinary) => {
    try {
      if (isBinary || raw instanceof Buffer) {
        // Binary frame — dump up to limit
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const totalSize = buffer.length;
        const slice = buffer.slice(0, BINARY_DUMP_LIMIT);
        const hex = slice.toString('hex');
        const b64 = slice.toString('base64');
        const truncated = totalSize > BINARY_DUMP_LIMIT;
        log("[MSG binary] frame received", { totalSize, truncated, dumpBytes: slice.length, hex_sample: hex.slice(0,1024), base64_sample: b64.slice(0,2048) });

        // attempt to decode as UTF-8 JSON
        let txt = null;
        try { txt = slice.toString('utf8'); } catch(e){}
        if (txt) {
          try {
            // If truncated but JSON may be incomplete; attempt full parse on full buffer if small
            let fullText = null;
            if (!truncated) fullText = buffer.toString('utf8');
            else {
              // try parsing truncated text in case it's still valid
              fullText = txt;
            }
            const parsed = JSON.parse(fullText);
            log("[MSG binary->JSON] parsed JSON (full)", JSON.stringify(parsed));
            // handle JSON message semantics
            handleJsonMessage(parsed);
            return;
          } catch(e){
            // not full/valid JSON — but we already logged hex/base64 above
            log("[MSG binary] binary not-JSON or truncated JSON (kept hex/base64 sample)");
            return;
          }
        } else {
          // non-text binary — we logged sample, nothing else
          return;
        }
      } else {
        // text message
        const text = String(raw);
        let msg = null;
        try {
          msg = JSON.parse(text);
        } catch(e){
          log("[MSG text] non-json text (sample)", text.slice(0,1000));
          return;
        }
        handleJsonMessage(msg);
      }
    } catch (e){
      log("[ERR] message handler", e?.message || e);
    }
  });

  function handleJsonMessage(msg){
    const arr = Array.isArray(msg) ? msg : [msg];
    for (const m of arr){
      // JSON ping (centrifugo-like) -> log fully and optionally respond
      if (m.ping !== undefined || m.type === 2) {
        log("[JSON] PING <-", JSON.stringify(m));
        if (RESPOND_JSON_PONG) {
          try {
            // Centrifugo-like pong: try standard variant
            const pongVariant = (m.type === 2) ? { type: 3 } : { pong: {} };
            ws.send(JSON.stringify(pongVariant));
            log("[JSON] PONG -> sent", pongVariant);
          } catch(e){
            log("[ERR] send json pong", e?.message || e);
          }
        }
        continue;
      }

      // connect ack
      if ((m.id === 1 && m.connect) || (m.result && m.id === 1)) {
        if (!gotConnectAck) {
          gotConnectAck = true;
          const clientId = (m.connect && m.connect.client) || (m.result?.connect?.client) || null;
          log("[LOG] connect_ack server", { client: clientId });
          // subscribe shortly after ack to mimic real client timing
          setTimeout(() => {
            CHANNELS.forEach((ch, idx) => {
              try {
                const sub = { id: 100 + idx, subscribe: { channel: ch } };
                ws.send(JSON.stringify(sub));
                log("[LOG] subscribe_sent client", { channel: ch, id: 100 + idx });
              } catch(e){ log("[ERR] subscribe send", e?.message || e); }
            });
          }, 120);
        }
        continue;
      }

      // sub ack
      if (typeof m.id === "number" && m.id >= 100 && (m.result === undefined || m.result)) {
        log("[LOG] sub_ok server", { id: m.id });
        continue;
      }

      // ignore heavy push payloads (spam) but note that push arrived
      if (m.push) {
        try {
          const ch = m.push.channel || "(unknown)";
          log("[PUSH] ignored (spam)", { channel: ch });
        } catch(e){}
        continue;
      }

      // fallback: log raw JSON
      try { log("[MSG other] sample", JSON.stringify(m).slice(0,400)); } catch(e){}
    }
  }

  ws.on("close", (code, reason) => {
    log("[CLOSE]", code, reason?.toString?.() || reason);
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

  // Watchdog: if no transport ping observed for long time -> log warning (does NOT force reconnect)
  (function watchdog(){
    const id = setInterval(() => {
      if (!ws) return clearInterval(id);
      if (ws.readyState !== WebSocket.OPEN) return;
      const last = lastTransportPingTs || 0;
      const age = Date.now() - last;
      if (last === 0 && age > 120_000) {
        log("[WATCHDOG] No ws-level ping observed in initial 120s (may rely on JSON pings)");
      } else if (last !== 0 && age > 120_000) {
        log("[WATCHDOG] Last ws-level ping age ms:", age);
      }
    }, 30_000);
  })();
}

// start
startClient().catch(err => { console.error("[FATAL]", err); process.exit(1); });

// graceful
process.on("SIGINT", () => { log("SIGINT, shutting"); stopped = true; safeClose(); setTimeout(()=>process.exit(0),500); });
process.on("SIGTERM", () => { log("SIGTERM, shutting"); stopped = true; safeClose(); setTimeout(()=>process.exit(0),500); });