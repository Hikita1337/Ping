// server.js — стабильный клиент, правильный JSON-PONG, фильтр спама
import WebSocket from "ws";
import fetch from "node-fetch";

const WS_URL = "wss://ws.cs2run.app/connection/websocket";
const CHANNELS = ["csgorun:crash", "csgorun:main"];
const RECONNECT_INTERVAL_MS = 5 * 60 * 1000; // 5 минут

let ws;
let forceReconnectTimer;

function log(...a){ console.log("[INFO]", ...a); }

async function getToken() {
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
    log("Token fetch failed:", err.message);
    return null;
  }
}

async function startWS() {
  const token = await getToken();
  if (!token) {
    log("Retry in 3s");
    return setTimeout(startWS, 3000);
  }

  log(`Connecting to ${WS_URL}`);
  ws = new WebSocket(WS_URL);

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

    if (forceReconnectTimer) clearTimeout(forceReconnectTimer);
    forceReconnectTimer = setTimeout(() => {
      log("5 minutes passed → force reconnect");
      safeClose();
    }, RECONNECT_INTERVAL_MS);
  });

  ws.on("message", raw => {
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch {
      return;
    }

    const msgs = Array.isArray(arr) ? arr : [arr];

    for (const msg of msgs) {
      // === SERVER PING (Centrifugo protocol) ===
      if (msg.ping !== undefined) {
        log("[PING] <-", JSON.stringify(msg));
        ws.send(JSON.stringify({ pong: {} }));
        log("[PONG] -> {pong:{}}");
        continue;
      }

      // CONNECT OK
      if (msg.result && msg.id === 1) {
        log("[ACK] CONNECT OK");
        continue;
      }

      // SUBSCRIBE OK
      if (msg.id === 100 || msg.id === 101) {
        log("[ACK] SUB OK id=" + msg.id);
        continue;
      }

      // Игровые push нам пока не нужны (очень много трафика)
      if (msg.push) continue;

      // Остальное → показать (редко)
      log("[MSG]", msg);
    }
  });

  ws.on("close", (code, reason) => {
    log(`[CLOSE] code=${code}, reason=${reason || "(none)"}`);
    restart("close");
  });

  ws.on("error", err => {
    log("[ERROR]", err.message);
    restart("error");
  });
}

function restart(reason) {
  log(`[RESTART] cause=${reason}`);
  setTimeout(startWS, 2000);
}

function safeClose() {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.close(); } catch {}
  }
}

startWS();