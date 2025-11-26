import WebSocket from "ws";
import fetch from "node-fetch";

const WS_URL = "wss://ws.cs2run.app/connection/websocket";
const CHANNELS = ["csgorun:crash", "csgorun:main"];
const RECONNECT_INTERVAL_MS = 5 * 60 * 1000; // 5 минут

let ws;
let reconnectTimer;

async function getToken() {
  console.log(`[INFO] Fetching token...`);

  try {
    const r = await fetch("https://cs2run.app/current-state", {
      cache: "no-store"
    });
    const j = await r.json();
    const token = j?.data?.main?.centrifugeToken;
    console.log(`[INFO] Token status: ${token ? "FOUND" : "NOT FOUND"}`);
    return token;
  } catch (err) {
    console.log("[ERR] Token fetch failed:", err.message);
    return null;
  }
}

async function startWS() {
  const token = await getToken();
  if (!token) {
    console.log("[WARN] Retry token in 3s");
    return setTimeout(startWS, 3000);
  }

  console.log(`[INFO] Connecting to ${WS_URL}`);
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("[WS] OPEN");

    ws.send(JSON.stringify({
      id: 1,
      connect: { token }
    }));
    console.log("[WS->] CONNECT sent");

    setTimeout(() => {
      CHANNELS.forEach((ch, i) => {
        ws.send(JSON.stringify({
          id: 100 + i,
          subscribe: { channel: ch }
        }));
        console.log(`[INFO] [SUBSCRIBE] requested: ${ch}`);
      });
    }, 200);

    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      console.log("\n[WS] 5 minutes passed — force reconnect\n");
      safeClose();
    }, RECONNECT_INTERVAL_MS);
  });

  ws.on("message", raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.log("[MSG RAW]", raw.toString());
      return;
    }

    if (msg.ping !== undefined) {
      console.log("[SERVER PING] <-", JSON.stringify(msg));
      ws.send(JSON.stringify({ pong: {} }));
      console.log("[CLIENT PONG] -> {pong:{}}");
      return;
    }

    if (msg.result && msg.id === 1) {
      console.log("[WS] CONNECT OK");
      return;
    }

    if (msg.push) return;

    console.log("[MSG JSON]", msg);
  });

  ws.on("close", (code, reason) => {
    console.log(`[WS] CLOSE: code=${code}, reason=${reason?.toString()}`);
    restart("close");
  });

  ws.on("error", err => {
    console.log("[WS] ERROR:", err.message);
    restart("error");
  });
}

function restart(reason) {
  console.log(`[WS] Restart triggered by ${reason}`);
  setTimeout(startWS, 2000);
}

function safeClose() {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.close(); } catch {}
  }
}

startWS();