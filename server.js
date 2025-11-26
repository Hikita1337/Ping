import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { createClient } from "@supabase/supabase-js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supa = createClient(SUPABASE_URL, SUPABASE_KEY);

const TARGET = "https://csgoyz.run/crash";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15";

async function run() {
  console.log("[LAUNCH] Chromium starting...");

  const browser = await puppeteer.launch({
    args: [
      ...chromium.args,
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
      "--user-agent=" + UA
    ],
    headless: chromium.headless,
    executablePath: await chromium.executablePath(),
    defaultViewport: {
      width: 1600,
      height: 900
    }
  });

  const page = await browser.newPage();
  await page.setUserAgent(UA);

  const client = await page.target().createCDPSession();
  await client.send("Network.enable");

  let wsSeen = false;

  client.on("Network.webSocketCreated", async (ev) => {
    wsSeen = true;
    console.log("[WS] CREATED:", ev.url);

    await supa.from("ws_logs").insert({
      direction: "meta",
      body: "WS_CREATED: " + ev.url,
      ts: new Date().toISOString()
    });
  });

  client.on("Network.webSocketFrameReceived", async ({ response }) => {
    await supa.from("ws_logs").insert({
      direction: "recv",
      body: response.payloadData,
      ts: new Date().toISOString()
    });
  });

  client.on("Network.webSocketFrameSent", async ({ response }) => {
    await supa.from("ws_logs").insert({
      direction: "send",
      body: response.payloadData,
      ts: new Date().toISOString()
    });
  });

  console.log("[NAVIGATE] →", TARGET);

  try {
    await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (err) {
    console.log("[WARN] Navigation didn’t fully complete:", err.message);
  }

  console.log("[WAIT] First WS or timeout…");

  const start = Date.now();
  while (!wsSeen && Date.now() - start < 80_000) {
    await new Promise(r => setTimeout(r, 300));
  }

  if (!wsSeen) {
    console.log("[FAIL] No WebSocket in 80s → EXIT");
    process.exit(1);
  }

  console.log("[OK] WebSocket detected. Sniffing started.");
}

run().catch(err => {
  console.error("FAIL:", err);
  process.exit(1);
});