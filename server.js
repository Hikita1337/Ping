// server.js — стабильный Centrifugo WebSocket клиент
import WebSocket from "ws";
import fetch from "node-fetch";

const WS_URL = "wss://ws.cs2run.app/connection/websocket";
const CHANNELS = ["csgorun:crash", "csgorun:main"];
const FORCE_RECONNECT_MS = 5 * 60 * 1000; // 5 минут

let ws;
let lastPingTs = null;
let reconnectTimer;

function log(...a) {
  console.log("[INFO]", ...a);
}

async function fetchToken() {
  log("Fetching token...");
  try {
    const r = await fetch("https://cs2run.app/current-state", {
      cache: "no-store"
    });
    const j = await r.json();
    const token = j?.data?.main?.centrifugeToken;
    log(`Token: ${token ? "FOUND" : "NOT FOUND"}`);
    return token;
  } catch (err) {
    log("Token fetch error:", err.message);
    return null;
  }
}

async function startWS() {
  const token = await fetchToken();
  if (!token) {
    log("Retry in 3s...");
    return setTimeout(startWS, 3000);
  }

  log(`Connecting to ${WS_URL}...`);
  ws = new WebSocket(WS_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Origin": "https://cs2run.app",
      "Sec-WebSocket-Protocol": "centrifugo.v2.json"
    }
  });

  ws.on("open", () => {
    log("[WS] OPEN");

    ws.send(JSON.stringify({
      id: 1,
      connect: { token, subs: {} }
    }));
    log("[CONNECT] sent");

    setTimeout(() => {
      CHANNELS.forEach((ch, i) => {
        ws.send(JSON.stringify({
          id: 100 + i,
          subscribe: { channel: ch }
        }));
        log(`[SUB] -> ${ch}`);
      });
    }, 200);

    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      log("[RECONNECT] timeout reached → reconnect");
      safeClose();
    }, FORCE_RECONNECT_MS);
  });

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    const arr = Array.isArray(msg) ? msg : [msg];

    for (const m of arr) {
      // Server PING (важная часть!)
      if (m.ping !== undefined) {
        lastPingTs = Date.now();
        log("[PING] <-", JSON.stringify(m));
        ws.send(JSON.stringify({ pong: {} }));
        log("[PONG] -> {}");
        continue;
      }

      if (m.result && m.id === 1) {
        log("[ACK] CONNECT OK");
        continue;
      }

      if (m.id === 100 || m.id === 101) {
        log(`[ACK] SUB OK id=${m.id}`);
        continue;
      }

      if (m.push) continue; // фильтр игрового спама

      log("[MSG]", m);
    }
  });

  ws.on("close", (code, reason) => {
    log(`[CLOSE] code=${code} reason=${reason || "(none)"}`);
    restart("close");
  });

  ws.on("error", err => {
    log("[ERROR]", err.message);
    restart("error");
  });
}

function restart(cause) {
  log(`[RESTART] cause=${cause}`);
  setTimeout(startWS, 2000);
}

function safeClose() {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.close(); } catch {}
  }
}

startWS();