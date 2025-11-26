// server.js
import WebSocket from "ws";
import fetch from "node-fetch";

const WS_URL = "wss://ws.cs2run.app/connection/websocket";
const CHANNELS = ["csgorun:crash", "csgorun:main"];
const RECONNECT_INTERVAL_MS = Number(process.env.RECONNECT_MS) || 5 * 60 * 1000;
const VERBOSE = (process.env.VERBOSE === "1"); // set to 1 if you want more details

let ws = null;
let pingTimestamp = null;
let reconnectTimer = null;

function info(...args){ console.log("[INFO]", ...args); }
function warn(...args){ console.warn("[WARN]", ...args); }
function debug(...args){ if(VERBOSE) console.log("[DBG]", ...args); }

async function getToken(){
  info("Requesting token...");
  try{
    const r = await fetch("https://cs2run.app/current-state", { cache: "no-store" });
    const j = await r.json();
    const token = j?.data?.main?.centrifugeToken || null;
    info("Token:", token ? "OK" : "MISSING");
    return token;
  }catch(err){
    warn("Token fetch failed:", err.message);
    return null;
  }
}

async function startWS(){
  const token = await getToken();
  if(!token){
    warn("No token — retry in 3s");
    return setTimeout(startWS, 3000);
  }

  info("Connecting to WS...");
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    info("[WS] OPEN");
    pingTimestamp = null;

    // send connect
    ws.send(JSON.stringify({ id:1, connect:{ token, subs:{} } }));
    info("[WS->] CONNECT");

    // subscribe (we log only the fact of subscribe)
    setTimeout(() => {
      CHANNELS.forEach((ch, i) => {
        ws.send(JSON.stringify({ id:100+i, subscribe:{ channel: ch } }));
        info("[SUBSCRIBE]", ch);
      });
    }, 200);

    // schedule forced reconnect
    if(reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      info("[WS] 5 min passed -> force reconnect");
      safeClose();
    }, RECONNECT_INTERVAL_MS);
  });

  // transport ping (binary)
  ws.on("ping", data => {
    pingTimestamp = Date.now();
    const hex = data ? Buffer.from(data).toString("hex") : "(empty)";
    info("[PING]", hex);
    // respond with exact payload — correct binary pong
    try {
      ws.pong(data);
      info("[PONG] SENT");
    } catch (e) {
      warn("[ERR] ws.pong failed:", e.message);
    }
  });

  ws.on("pong", data => {
    const hex = data ? Buffer.from(data).toString("hex") : "(empty)";
    const latency = pingTimestamp ? (Date.now() - pingTimestamp) : null;
    info("[PONG RCV]", hex);
    if(latency !== null){
      info("[LATENCY]", latency + "ms");
      if(latency > 2000){
        warn("[WARN] latency high -> reconnect");
        safeClose();
      }
    }
  });

  ws.on("message", raw => {
    // try to parse JSON — if it's push from channels, ignore silently
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // text not JSON; log only if verbose
      debug("[MSG TEXT]", raw.toString());
      return;
    }

    // FILTER: ignore channel push spam
    // j.push is the big spam payload (bets, items, players)
    if(parsed && parsed.push) return;

    // keep only useful control messages:
    // - connect ack (result for id:1)
    // - subscribe results (id >=100)
    if(parsed && parsed.result && parsed.id === 1){
      info("[WS] CONNECTED ACK");
      return;
    }
    if(parsed && parsed.result && parsed.id >= 100 && parsed.id < 200){
      info("[WS] SUBSCRIBE ACK id=" + parsed.id);
      return;
    }

    // any other message we log (rare)
    info("[MSG JSON]", JSON.stringify(parsed));
  });

  ws.on("close", (code, reason) => {
    info(`[WS] CLOSE ${code} ${reason?.toString()}`);
    restart("close");
  });

  ws.on("error", err => {
    warn("[WS] ERROR", err?.message || err);
    restart("error");
  });
}

function restart(reason){
  info("[WS] Restart triggered by", reason);
  // small backoff
  setTimeout(startWS, 2000);
}

function safeClose(){
  try{
    if(ws && ws.readyState === ws.OPEN) ws.close();
  }catch(e){}
}

startWS();