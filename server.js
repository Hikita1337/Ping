import WebSocket from "ws";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const WS_URL = "wss://ws.cs2run.app/connection/websocket";
const CHANNELS = ["csgorun:crash", "csgorun:main"];

// === Supabase ===
const SUPABASE_URL = "https://pdsuiqmddqsllarznceh.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBkc3VpcW1kZHFzbGxhcnpuY2VoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MTc4MjM5MywiZXhwIjoyMDc3MzU4MzkzfQ.oz3-A6R7V7FM2ZKyTV1BrMEhrZKvTherL9sCyCteIXE";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function logEvent(event, direction, payload = null) {
  try {
    await supabase.from("ws_logs").insert({
      event,
      direction,
      payload: payload ? JSON.stringify(payload) : null
    });
  } catch (e) {
    console.log("[DB LOG ERROR]", e.message);
  }
}

// ===========
let ws;
let connectPending = true;

async function getToken() {
  console.log("[INFO] Fetching token...");
  try {
    const r = await fetch("https://cs2run.app/current-state", {
      cache: "no-store",
    });
    const j = await r.json();
    const token = j?.data?.main?.centrifugeToken;
    console.log(`[INFO] Token: ${token ? "FOUND" : "NOT FOUND"}`);
    return token;
  } catch {
    console.log("[ERR] Token fetch failed");
    return null;
  }
}

async function startWS() {
  const token = await getToken();
  if (!token) return setTimeout(startWS, 2000);

  console.log("[START] connecting...");
  ws = new WebSocket(WS_URL);

  connectPending = true;

  ws.once("open", () => {
    console.log("[WS] OPEN");
    logEvent("open", "client");

    // 1) Transport PONG сразу
    try {
      ws.pong();
      logEvent("transport_pong_sent", "client");
    } catch {}

    // 2) CONNECT сразу после transport Pong
    const connectMsg = { id: 1, connect: { token, subs: {} } };
    ws.send(JSON.stringify(connectMsg));
    logEvent("connect_sent", "client");
  });

  ws.on("message", raw => {
    console.log("[WS MSG]", raw.toString());

    let msg;
    try { msg = JSON.parse(raw); }
    catch {
      logEvent("raw_binary", "server");
      return;
    }

    const arr = Array.isArray(msg) ? msg : [msg];
    for (const m of arr) {

      // JSON CONNECT-ACK
      if (m.connect && m.id === 1) {
        logEvent("connect_ack", "server");

        if (connectPending) {
          connectPending = false;

          // 3) JSON-PONG СРАЗУ после connect-ack
          try {
            ws.send(JSON.stringify({ pong: {} }));
            logEvent("json_pong_sent", "client");
          } catch {}

          // Только теперь подписки
          setTimeout(() => {
            CHANNELS.forEach((ch, idx) => {
              ws.send(JSON.stringify({
                id: 100 + idx,
                subscribe: { channel: ch },
              }));
              logEvent("subscribe_sent", "client", { channel: ch });
            });
          }, 150);
        }
        continue;
      }

      // ACK подписки
      if (m.id === 100 || m.id === 101) {
        logEvent("sub_ok", "server");
        continue;
      }

      // Остальное слишком жирное — временно не логируем
      logEvent("other_message", "server", { sample: raw.toString().slice(0, 200) });
    }
  });

  ws.on("close", (code, reason) => {
    console.log("[CLOSE]", code, reason);
    logEvent("close", "server", { code, reason });
    restart();
  });

  ws.on("error", err => {
    console.log("[ERROR]", err.message);
    restart();
  });
}

function restart() {
  setTimeout(startWS, 1000);
}

startWS();