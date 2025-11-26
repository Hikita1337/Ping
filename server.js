import WebSocket from "ws";
import fetch from "node-fetch";
import pkg from "@supabase/supabase-js";
const { createClient } = pkg;

const SUPABASE_URL = "https://pdsuiqmddqsllarznceh.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBkc3VpcW1kZHFzbGxhcnpuY2VoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MTc4MjM5MywiZXhwIjoyMDc3MzU4MzkzfQ.oz3-A6R7V7FM2ZKyTV1BrMEhrZKvTherL9sCyCteIXE";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const WS_URL = "wss://ws.cs2run.app/connection/websocket";
const CHANNELS = ["csgorun:crash", "csgorun:main"];

let ws;

async function logEvent(event, source, payload = null) {
  await supabase.from("ws_events").insert({
    event,
    source,
    payload
  });
  console.log(`[LOG->DB] ${event}`);
}

async function getToken() {
  console.log("[INFO] Fetching token...");
  try {
    const r = await fetch("https://cs2run.app/current-state", {
      cache: "no-store",
    });
    const j = await r.json();
    const token = j?.data?.main?.centrifugeToken;
    console.log("[INFO] Token:", token ? "FOUND" : "NOT FOUND");
    return token;
  } catch {
    return null;
  }
}

async function start() {
  const token = await getToken();
  if (!token) {
    setTimeout(start, 3000);
    return;
  }

  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("[WS] OPEN");
    logEvent("open", "client");

    ws.send(JSON.stringify({
      id: 1,
      connect: { token, subs: {} }
    }));
    logEvent("connect_sent", "client");

    setTimeout(() => {
      CHANNELS.forEach((ch, i) => {
        ws.send(JSON.stringify({
          id: 100 + i,
          subscribe: { channel: ch }
        }));
        logEvent("subscribe_sent", "client", { ch });
      });
    }, 200);
  });

  ws.on("message", raw => {
  let msg;
  try { msg = JSON.parse(raw); } catch {
    console.log("[RAW]", raw.toString());
    return;
  }

  const arr = Array.isArray(msg) ? msg : [msg];

  arr.forEach(m => {
    // Логируем всё для анализа (но только в консоль!)
    console.log("[WS MSG]", JSON.stringify(m).slice(0, 300));

    // Вариант 1: ping в старом формате
    if (m.ping !== undefined) {
      logEvent("ping", "server");
      ws.send(JSON.stringify({ pong: {} }));
      logEvent("pong", "client");
      return;
    }

    // Вариант 2: format by Centrifugo: { "method": "ping" }
    if (m.method === "ping") {
      logEvent("ping", "server");
      ws.send(JSON.stringify({ method: "pong" }));
      logEvent("pong", "client");
      return;
    }

    // CONNECT OK
    if (m.result && m.id === 1) return logEvent("connect_ok", "server");

    // SUB OK
    if (m.id === 100 || m.id === 101)
      return logEvent("sub_ok", "server", { id: m.id });

    // всё остальное — пропускаем
  });
});
  ws.on("close", (code, reason) => {
    console.log("[CLOSE]", code, reason?.toString());
    logEvent("close", "server", { code, reason });

    setTimeout(start, 2000);
  });

  ws.on("error", err => {
    console.log("[ERR]", err.message);
    logEvent("error", "client", { msg: err.message });
  });
}

start();