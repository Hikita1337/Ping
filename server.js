// server.js - improved: binary-message responder + transport pong + logging
import WebSocket from "ws";
import fetch from "node-fetch";
import crypto from "crypto";

const WS_URL = "wss://ws.cs2run.app/connection/websocket";
const CHANNELS = ["csgorun:crash", "csgorun:main"];

const CLIENT_PING_INTERVAL_MS = 25 * 1000; // client-initiated ping
const FORCE_RECONNECT_MS = 5 * 60 * 1000; // forced reconnect
const TOKEN_RETRY_MS = 3000;

let ws = null;
let clientPingTimer = null;
let forceReconnectTimer = null;
let reconnectBackoffTimer = null;
let pingTimestamp = null;
const pendingClientPings = new Map(); // hex -> ts

const hex = (buf) => (buf ? Buffer.from(buf).toString("hex") : "(empty)");

function info(...a){ console.log("[INFO]", ...a); }
function warn(...a){ console.warn("[WARN]", ...a); }
function err(...a){ console.error("[ERR]", ...a); }

async function getToken(){
  info("Requesting token...");
  try {
    const r = await fetch("https://cs2run.app/current-state", { cache: "no-store" });
    const j = await r.json();
    const token = j?.data?.main?.centrifugeToken || null;
    info("Token:", token ? "OK" : "MISSING");
    return token;
  } catch(e){
    warn("Token fetch failed:", e?.message || e);
    return null;
  }
}

function sendClientPing(){
  if (!ws || ws.readyState !== ws.OPEN) return;
  const payload = crypto.randomBytes(2);
  const h = hex(payload);
  try{
    ws.ping(payload); // transport ping (preferred)
    pendingClientPings.set(h, Date.now());
    info("[CLIENT PING] ->", h);
  }catch(e){
    warn("[CLIENT PING] failed:", e?.message || e);
  }
}

function clearTimers(){
  if (clientPingTimer){ clearInterval(clientPingTimer); clientPingTimer = null; }
  if (forceReconnectTimer){ clearTimeout(forceReconnectTimer); forceReconnectTimer = null; }
  if (reconnectBackoffTimer){ clearTimeout(reconnectBackoffTimer); reconnectBackoffTimer = null; }
}

function safeCloseAndRestart(reason){
  try { if (ws && ws.readyState === ws.OPEN) ws.close(); } catch(e){}
  clearTimers();
  reconnectBackoffTimer = setTimeout(() => startWS(), 2000);
  info("[RESTART] scheduled because:", reason);
}

async function startWS(){
  const token = await getToken();
  if (!token){
    warn("No token — retry in 3s");
    return setTimeout(startWS, TOKEN_RETRY_MS);
  }

  info("Connecting to", WS_URL);
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    info("[WS] OPEN");
    pendingClientPings.clear();

    // handshake
    const connectMsg = { id: 1, connect: { token, subs: {} } };
    try { ws.send(JSON.stringify(connectMsg)); info("[WS->] CONNECT sent"); }
    catch(e){ warn("CONNECT send failed:", e?.message || e); }

    // subscribe (log only fact)
    setTimeout(() => {
      CHANNELS.forEach((ch, i) => {
        try {
          ws.send(JSON.stringify({ id: 100 + i, subscribe: { channel: ch } }));
          info("[SUBSCRIBE] requested:", ch);
        } catch(e){ warn("[SUBSCRIBE] failed:", ch, e?.message || e); }
      });
    }, 200);

    // start client pings
    if (!clientPingTimer){
      sendClientPing();
      clientPingTimer = setInterval(sendClientPing, CLIENT_PING_INTERVAL_MS);
    }

    // schedule forced reconnect
    if (forceReconnectTimer) clearTimeout(forceReconnectTimer);
    forceReconnectTimer = setTimeout(() => {
      info("[WS] Force reconnect (5m elapsed)");
      safeCloseAndRestart("forced-interval");
    }, FORCE_RECONNECT_MS);
  });

  // Transport-level ping received from server (ws library event)
  ws.on("ping", (data) => {
    const h = hex(data);
    info("[TRANSPORT PING] <-", h);
    // record timestamp for latency calculation (server-initiated ping)
    pingTimestamp = Date.now();
    // reply transport-level pong with same payload
    try {
      ws.pong(data);
      info("[TRANSPORT PONG] ->", h);
    } catch(e){
      warn("[TRANSPORT PONG] failed:", e?.message || e);
    }
  });

  // transport-level pong received
  ws.on("pong", (data) => {
    const h = hex(data);
    info("[TRANSPORT PONG RCV] <-", h);
    // if corresponds to client-initiated ping, calc latency
    if (pendingClientPings.has(h)){
      const ts = pendingClientPings.get(h);
      const latency = Date.now() - ts;
      pendingClientPings.delete(h);
      info("[LATENCY] client-ping ->", latency + "ms");
      if (latency > 2000){
        warn("[WARN] high latency, forcing reconnect");
        safeCloseAndRestart("high-latency");
      }
    } else if (pingTimestamp){
      const latency = Date.now() - pingTimestamp;
      info("[LATENCY] server-ping ->", latency + "ms");
      pingTimestamp = null;
      if (latency > 2000){
        warn("[WARN] high latency for server ping -> reconnect");
        safeCloseAndRestart("high-latency-server");
      }
    }
  });

  // message handler: catches text JSON and binary application messages
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // binary application-level message: log hex and reply echo + transport pong
      const h = hex(data);
      info("[BINARY MSG] <-", h);

      // attempt transport-level pong (in case server expects pong frame)
      try {
        ws.pong(data);
        info("[AUTO TRANSPORT PONG] ->", h);
      } catch(e){
        debug && warn && warn("[AUTO TRANSPORT PONG] failed:", e?.message || e);
      }

      // also send application-level echo (some servers expect echo)
      try {
        ws.send(data);
        info("[APP ECHO SENT] ->", h);
      } catch(e){
        warn("[APP ECHO SEND] failed:", e?.message || e);
      }

      return;
    }

    // text message (likely JSON)
    let parsed = null;
    try { parsed = JSON.parse(data); } catch(e){
      // not JSON; ignore
      return;
    }

    // filter noisy push messages
    if (parsed && parsed.push) return;

    // log useful control messages
    if (parsed && parsed.result && parsed.id === 1){
      info("[WS] CONNECT ACK");
      return;
    }
    if (parsed && parsed.result && parsed.id >= 100 && parsed.id < 200){
      info("[WS] SUBSCRIBE ACK id=" + parsed.id);
      return;
    }

    // any other useful text-level message
    info("[MSG JSON]", JSON.stringify(parsed));
  });

  ws.on("close", (code, reason) => {
    info("[WS] CLOSE code=" + code + " reason=" + (reason?.toString() || "(none)"));
    clearTimers();
    setTimeout(() => startWS(), 2000);
    info("[WS] Restarting in 2s");
  });

  ws.on("error", (e) => {
    warn("[WS] ERROR", e?.message || e);
    // ws will likely trigger close after error; restart handled there
  });
}

// start
startWS();