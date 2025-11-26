import WebSocket from "ws";
import fetch from "node-fetch";

const WS_URL = "wss://ws.cs2run.app/connection/websocket";
const CHANNELS = ["csgorun:crash", "csgorun:main"];
const RECONNECT_INTERVAL_MS = 5 * 60 * 1000; // 5 минут

let ws;
let pingTimestamp = null;
let reconnectTimer;

async function getToken() {
  console.log(`\n[INFO] Requesting token...`);
  try {
    const r = await fetch("https://cs2run.app/current-state", {
      cache: "no-store"
    });
    const j = await r.json();
    const token = j?.data?.main?.centrifugeToken;
    console.log(`[INFO] Token: ${token ? "OK" : "MISSING"}`);
    return token;
  } catch (err) {
    console.log("[ERR] Token fetch failed:", err.message);
    return null;
  }
}

async function startWS() {
  const token = await getToken();
  if (!token) {
    console.log("[WARN] Token retry in 3s");
    return setTimeout(startWS, 3000);
  }

  console.log("[WS] Connecting...");
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("[WS] OPEN");

    pingTimestamp = null;

    ws.send(JSON.stringify({
      id: 1,
      connect: { token, subs: {} }
    }));
    console.log("[WS->] CONNECT sent");

    setTimeout(() => {
      CHANNELS.forEach((ch, i) => {
        ws.send(JSON.stringify({
          id: 100 + i,
          subscribe: { channel: ch }
        }));
        console.log("[SUB]", ch);
      });
    }, 200);

    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      console.log("\n[WS] 5 min passed → force reconnect\n");
      safeClose();
    }, RECONNECT_INTERVAL_MS);
  });

  ws.on("ping", data => {
    pingTimestamp = Date.now();
    console.log("[PING]", data?.toString("hex") || "(empty)");
    ws.pong(data);
    console.log("[PONG] SENT");
  });

  ws.on("pong", data => {
    const latency = pingTimestamp ? (Date.now() - pingTimestamp) : null;
    console.log("[PONG RCV]", data?.toString("hex") || "(empty)");
    if (latency !== null) {
      console.log(`[LATENCY] ${latency}ms`);
      if (latency > 2000) {
        console.log("[WARN] High latency! Reconnecting...");
        safeClose();
      }
    }
  });

ws.on("message", raw => {
  try {
    const j = JSON.parse(raw);

    // ЦЕНТРАЛЬНАЯ СТРОКА:
    // Игровые push'и > больше не логируем
    if (j.push) return; 

    if (j.ping) return;
    if (j.result && j.id === 1) {
      console.log("[WS] CONNECTED ACK");
      return;
    }

    // Всё полезное оставляем
    console.log("[MSG JSON]", j);
  } catch {
    console.log("[MSG TEXT]", raw.toString());
  }
});

  ws.on("close", (code, reason) => {
    console.log(`[WS] CLOSE ${code} ${reason?.toString()}`);
    restart("close");
  });

  ws.on("error", err => {
    console.log("[WS] ERROR", err.message);
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