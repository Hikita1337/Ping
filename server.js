// server.js
// ES module (node >= 18/20/22). Put "type": "module" in package.json.
import WebSocket from "ws";
import fetch from "node-fetch";
import express from "express";

const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const TOKEN_URL = process.env.TOKEN_URL || "https://cs2run.app/current-state";
const CHANNELS = (process.env.CHANNELS || "csgorun:crash, csgorun:main").split(/\s*,\s*/);
const PORT = Number(process.env.PORT || 10000);
const LOG_PUSHES = process.env.LOG_PUSHES === "1"; // если =1 — логировать push-данные (по умолчанию выключено)
const AUTO_RECONNECT_BACKOFF = 2000;

function now() { return (new Date()).toISOString(); }
function hex(buf){ return Buffer.isBuffer(buf) ? buf.toString("hex") : Buffer.from(String(buf)).toString("hex"); }
function b64(buf){ return Buffer.isBuffer(buf) ? buf.toString("base64") : Buffer.from(String(buf)).toString("base64"); }

async function fetchToken(){
  try{
    const r = await fetch(TOKEN_URL, { cache: "no-store" });
    const j = await r.json();
    const token = j?.data?.main?.centrifugeToken;
    console.log(now(), "[INFO] Token fetch ->", token ? "FOUND" : "MISSING");
    return token || null;
  }catch(e){
    console.log(now(), "[ERR] token fetch failed", String(e));
    return null;
  }
}

function tryParseJson(buf){
  try{
    const txt = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
    return JSON.parse(txt);
  }catch(e){
    return null;
  }
}

function startHealthServer(){
  const app = express();
  app.get("/", (req,res)=>res.send("ok"));
  app.get("/health", (req,res)=>res.json({ ok: true, ts: new Date().toISOString() }));
  app.listen(PORT, ()=>console.log(now(), "[HTTP] listening", PORT));
}

// Main WS logic
let shouldRun = true;
async function runLoop(){
  while(shouldRun){
    const token = await fetchToken();
    if(!token){ console.log(now(), "[RUN] no token — retry in 3s"); await new Promise(r=>setTimeout(r,3000)); continue; }
    console.log(now(), "[RUN] connecting to", WS_URL);

    let ws;
    try{
      ws = new WebSocket(WS_URL);

      // transport-level ping/pong handling
      ws.on("ping", (data) => {
        try {
          ws.pong(data); // reply transport ping immediately
        } catch(e){}
        console.log(now(), "[TRANSPORT] ping recv -> pong sent (hex)", data ? hex(data) : "(empty)");
      });

      ws.on("pong", (data) => {
        console.log(now(), "[TRANSPORT] pong recv (hex)", data ? hex(data) : "(empty)");
      });

      ws.on("open", () => {
        console.log(now(), "[WS] OPEN");
        // send Centrifugo connect JSON (same shape as browser)
        const connectPayload = { id: 1, connect: { token, subs: {} } };
        try { ws.send(JSON.stringify(connectPayload)); console.log(now(), "[WS->] CONNECT sent"); }
        catch(e){ console.log(now(), "[ERR] send connect:", e?.message || e); }
        // subscribe after tiny delay
        setTimeout(()=> {
          CHANNELS.forEach((ch, i) => {
            const id = 100 + i;
            const payload = { id, subscribe: { channel: ch } };
            try { ws.send(JSON.stringify(payload)); console.log(now(), "[WS->] SUBSCRIBE", ch); }
            catch(e){ console.log(now(), "[ERR] subscribe send:", e?.message || e); }
          });
        }, 150);
      });

      // message: can be Buffer (binary) or string (text)
      ws.on("message", (data, isBinary) => {
        const size = Buffer.isBuffer(data) ? data.length : String(data).length;
        let hexSample = Buffer.isBuffer(data) ? data.toString("hex") : undefined;
        let b64Sample = Buffer.isBuffer(data) ? data.toString("base64") : undefined;

        // Try parse JSON payload if it's text or JSON binary
        const parsed = tryParseJson(data);

        // Logging: raw + parsed (console)
        if(Buffer.isBuffer(data)){
          console.log(now(), "[WS MSG] (binary) size=", size, hexSample ? hexSample.slice(0,240) : "", b64Sample ? "" : "");
        } else {
          console.log(now(), "[WS MSG] (text) size=", size, String(data).slice(0,240));
        }
        if(parsed) console.log(now(), "[WS MSG JSON]", JSON.stringify(parsed));

        // === handle Centrifugo-style ping/pong inside JSON ===
        if(parsed && parsed.ping !== undefined){
          // server asks for JSON pong — respond immediately with JSON { pong: {} } (same shape we've seen)
          try {
            const pongPayload = { pong: {} };
            ws.send(JSON.stringify(pongPayload));
            console.log(now(), "[JSON PONG] ->", JSON.stringify(pongPayload));
          } catch(e){
            console.log(now(), "[ERR] send json-pong:", e?.message || e);
          }
          return;
        }

        // If parsed and msg is connect ack or subscribe ack — log minimal and continue
        if(parsed && parsed.result && parsed.id === 1){
          console.log(now(), "[WS] CONNECT ACK (server result)");
          return;
        }
        if(parsed && (parsed.id >= 100 && parsed.id < 200)){
          // subscribe ack or error; log and return
          if(parsed.error) console.log(now(), "[WS] SUB/ERR", parsed.id, parsed.error);
          else console.log(now(), "[WS] SUB OK id=", parsed.id);
          return;
        }

        // If it's Centrifugo push messages — avoid spam
        if(parsed && parsed.push){
          // log that we received push on channel, but skip big payload unless LOG_PUSHES=1
          const ch = parsed.push.channel;
          console.log(now(), `[PUSH] channel=${ch} (omitted content)`);
          if(LOG_PUSHES) console.log(now(), "[PUSH DATA]", JSON.stringify(parsed.push.pub));
          return;
        }

        // Some servers send empty JSON `{}` as transport marker; we still log it above.
        // If nothing matched — keep printed raw.
      });

      ws.on("close", (code, reason) => {
        const rs = reason && reason.length ? reason.toString() : "";
        console.log(now(), `[WS] CLOSE code=${code} reason=${rs}`);
        // If server closed due to no pong (e.g. 3012) we'll reconnect in loop
      });

      ws.on("error", (err) => {
        console.log(now(), "[WS ERROR]", err?.message || err);
      });

      // wait until socket closes
      await new Promise((resolve) => { ws.once("close", resolve); ws.once("error", resolve); });

    } catch(e){
      console.log(now(), "[RUN ERR]", e?.message || e);
    } finally {
      try{ if(ws && ws.readyState !== WebSocket.CLOSED) ws.terminate(); } catch(e){}
      console.log(now(), "[RUN] sleeping before reconnect", AUTO_RECONNECT_BACKOFF, "ms");
      await new Promise(r=>setTimeout(r, AUTO_RECONNECT_BACKOFF));
    }
  }
}

startHealthServer();
runLoop().catch(e=>console.log("[FATAL]", String(e)));