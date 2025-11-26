import puppeteer from "puppeteer";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TARGET_URL = process.env.TARGET_URL;

if (!SUPABASE_URL || !SUPABASE_KEY || !TARGET_URL) {
  console.error("Missing env vars");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

async function logWS(direction, payload, event_type, ws_channel = null) {
  await sb.from("ws_logs").insert([
    { direction, payload, event_type, ws_channel }
  ]);
}

async function run() {
  console.log("[LAUNCH] Chromium starting...");

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox"
    ]
  });

  const page = await browser.newPage();
  console.log("[OPEN] Navigating to:", TARGET_URL);

  await page.goto(TARGET_URL, { waitUntil: "networkidle2" });

  console.log("[HOOK] Attaching WebSocket listeners...");

  page.on("websocketcreated", ws => {
    console.log("[WS] New socket →", ws.url());

    ws.on("framereceived", async frame => {
      await logWS(
        "recv",
        frame.payload,
        "message"
      );
    });

    ws.on("framesent", async frame => {
      await logWS(
        "send",
        frame.payload,
        "message"
      );
    });
  });

  console.log("[RUN] Monitoring Traffic...");

  // Работать бесконечно
  setInterval(() => {}, 60 * 1000);
}

run().catch(err => console.error("FAIL:", err));