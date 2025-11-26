import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supa = createClient(SUPABASE_URL, SUPABASE_KEY);

// Куда заходим (как пользователь)
const TARGET = "https://csgoyz.run/crash";

// User-Agent как Safari iPhone
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.7 Mobile/15E148 Safari/604.1";

async function run() {
  console.log("[LAUNCH] Chromium starting...");

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless
  });

  const page = await browser.newPage();
  await page.setUserAgent(UA);

  await page.setViewport({
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
  });

  const client = await page.target().createCDPSession();

  // HTTP + WS logging
  await client.send("Network.enable");

  client.on("Network.webSocketFrameReceived", async ({ requestId, timestamp, response }) => {
    await supa.from("ws_logs").insert({
      direction: "recv",
      body: response.payloadData,
      ts: new Date().toISOString()
    });
  });

  client.on("Network.webSocketFrameSent", async ({ requestId, timestamp, response }) => {
    await supa.from("ws_logs").insert({
      direction: "send",
      body: response.payloadData,
      ts: new Date().toISOString()
    });
  });

  client.on("Network.requestWillBeSent", async ({ request }) => {
    await supa.from("ws_logs").insert({
      direction: "http_req",
      body: request.url,
      ts: new Date().toISOString()
    });
  });

  console.log("[NAVIGATE] →", TARGET);
  await page.goto(TARGET, { waitUntil: "networkidle2" });

  console.log("[READY] Sniffing traffic…");
}

run().catch(err => {
  console.error("FAIL:", err);
  process.exit(1);
});