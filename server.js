// server.js — финальная версия
// Node (ESM) + ws
// Установка: npm i ws

import WebSocket from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";

// ----------------- Конфиг (env или дефолты) -----------------
const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const TOKEN_URL = process.env.TOKEN_URL || "https://cs2run.app/current-state";
const CHANNEL = process.env.CHANNEL || "csgorun:crash"; // подписка для видимости
const PORT = Number(process.env.PORT || 10000);

const MAX_LOG_ENTRIES = Number(process.env.MAX_LOG_ENTRIES || 25000);
const MAX_LOG_BYTES = Number(process.env.MAX_LOG_BYTES || 100 * 1024 * 1024); // 100 MiB
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 5 * 60 * 1000); // 5 минут
const OPEN_TIMEOUT_MS = Number(process.env.OPEN_TIMEOUT_MS || 15000);

// ----------------- Состояние -----------------
let ws = null;
let running = true;
let reconnectAttempts = 0;

let sessionStartTs = null;
let lastPongTs = null;
let lastDisconnect = null;

// лог-буфер (круговой с ограничением по записям и по байтам)
let logs = [];
let logsBytes = 0;

function nowIso() { return new Date().toISOString(); }

// ----------------- Логирование (пуш-уведомления ОТСЕКАЕМ полностью) -----------------
function approxSizeOfObj(o) {
  try {
    return Buffer.byteLength(JSON.stringify(o), "utf8");
  } catch {
    return 200;
  }
}
function pushLog(entry) {
  entry.ts = nowIso();
  const size = approxSizeOfObj(entry);
  logs.push(entry);
  logsBytes += size;

  // trim by count
  while (logs.length > MAX_LOG_ENTRIES || logsBytes > MAX_LOG_BYTES) {
    const removed = logs.shift();
    logsBytes -= approxSizeOfObj(removed);
    if (logsBytes < 0) logsBytes = 0;
  }

  // Для консоли выводим только важные типы (не пуши)
  const noisyTypes = new Set(["push", "push_full", "raw_msg"]);
  if (!noisyTypes.has(entry.type)) {
    // компактный human-readable вывод
    console.log(JSON.stringify(entry));
  } else {
    // не выводим ничего для пушей
  }
}

// ----------------- Вспомогательные -----------------
async function fetchToken() {
  try {
    const resp = await fetch(TOKEN_URL, { cache: "no-store" });
    const j = await resp.json();
    const token = j?.data?.main?.centrifugeToken || null;
    pushLog({ type: "token_fetch", ok: !!token });
    return token;
  } catch (e) {
    pushLog({ type: "token_fetch_error", error: String(e) });
    return null;
  }
}

function makeBinaryJsonPong() {
  return Buffer.from(JSON.stringify({ type: 3 }));
}

// ----------------- Обработчики WS -----------------
function attachWsHandlers(socket) {
  socket.on("open", () => {
    reconnectAttempts = 0;
    sessionStartTs = Date.now();
    lastPongTs = null;
    pushLog({ type: "ws_open", url: WS_URL });
    console.log("[WS] OPEN");
  });

  socket.on("message", (data, isBinary) => {
    // Попытка распарсить JSON (если возможно)
    let parsed = null;
    let txt;
    try {
      txt = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      parsed = JSON.parse(txt);
    } catch {
      parsed = null;
    }

    // Если JSON и пустой объект {} — это обычный центрифюжный "ping" -> отвечаем бинарным {"type":3}
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length === 0) {
      try {
        const pong = makeBinaryJsonPong();
        socket.send(pong, { binary: true }, (err) => {
          if (err) pushLog({ type: "json_pong_send_error", error: String(err) });
          else {
            lastPongTs = Date.now();
            pushLog({ type: "json_pong_sent", reason: "server_empty_json" });
          }
        });
      } catch (e) {
        pushLog({ type: "json_pong_exception", error: String(e) });
      }
      return;
    }

    // Если connect ack (id=1 && connect) — логируем
    if (parsed && parsed.id === 1 && parsed.connect) {
      pushLog({ type: "connect_ack", client: parsed.connect.client || null, meta: parsed.connect });
      return;
    }

    // Если сообщение имеет поле push — ОТСЕКАЕМ: НЕ ЛОГИРУЕМ и НЕ сохраняем (никаких следов)
    if (parsed && parsed.push) {
      // deliberately do nothing: ignore push entirely
      return;
    }

    // Если это сообщения служебного характера (id, errors и т.п.) — логируем кратко
    if (parsed && parsed.id !== undefined) {
      pushLog({ type: "msg_with_id", id: parsed.id, body_summary: parsed.error ? parsed.error : "ok" });
      return;
    }

    // Если всё прочее — минимально отмечаем (не сохраняем большие raw-полета)
    if (parsed) {
      pushLog({ type: "message_parsed", summary: typeof parsed === "object" ? Object.keys(parsed).slice(0,5) : String(parsed).slice(0,200) });
      return;
    }

    // непарсируемое тело — тоже фиксируем кратко
    pushLog({ type: "message_nonjson", size: Buffer.isBuffer(data) ? data.length : String(data).length });
  });

  // транспортные ping/pong
  socket.on("ping", (data) => {
    // отвечаем transport-level pong
    try {
      socket.pong(data);
      pushLog({ type: "transport_ping_recv" });
    } catch (e) {
      pushLog({ type: "transport_ping_err", error: String(e) });
    }
  });

  socket.on("pong", (data) => {
    lastPongTs = Date.now();
    pushLog({ type: "transport_pong_recv" });
  });

  socket.on("close", (code, reasonBuf) => {
    const reason = (reasonBuf && reasonBuf.length) ? reasonBuf.toString() : "";
    const durationMs = sessionStartTs ? (Date.now() - sessionStartTs) : 0;
    lastDisconnect = { ts: nowIso(), code, reason, duration_ms: durationMs };
    pushLog({ type: "ws_close", code, reason, duration_ms: durationMs });
    console.log(`[WS] CLOSE code=${code} reason=${reason} duration=${Math.round(durationMs/1000)}s`);
    sessionStartTs = null;
  });

  socket.on("error", (err) => {
    pushLog({ type: "ws_error", error: String(err) });
    console.error("[WS ERROR]", err?.message || err);
  });
}

// ----------------- Основной цикл (connect -> subscribe -> wait close -> reconnect) -----------------
async function mainLoop() {
  while (running) {
    try {
      const token = await fetchToken();
      if (!token) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      pushLog({ type: "start_connect", url: WS_URL, channel: CHANNEL });
      console.log("[RUN] connecting to", WS_URL);

      ws = new WebSocket(WS_URL, { handshakeTimeout: OPEN_TIMEOUT_MS });
      attachWsHandlers(ws);

      // дождемся open или error/timeout
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("ws open timeout")), OPEN_TIMEOUT_MS);
        ws.once("open", () => { clearTimeout(to); resolve(); });
        ws.once("error", (e) => { clearTimeout(to); reject(e); });
      });

      // отправляем connect payload
      try {
        const connectPayload = { id: 1, connect: { token, subs: {} } };
        ws.send(JSON.stringify(connectPayload));
        pushLog({ type: "connect_sent" });
        console.log("[WS->] CONNECT sent");
      } catch (e) {
        pushLog({ type: "connect_send_error", error: String(e) });
      }

      // подписываемся (видимость) — body пушей мы игнорируем далее
      await new Promise(r => setTimeout(r, 200));
      try {
        const payload = { id: 100, subscribe: { channel: CHANNEL } };
        ws.send(JSON.stringify(payload));
        pushLog({ type: "subscribe_sent", channel: CHANNEL, id: 100 });
        console.log("[WS->] subscribe", CHANNEL);
      } catch (e) {
        pushLog({ type: "subscribe_send_error", error: String(e) });
      }

      // ждём закрытия сокета (нет авто-переподключения внутри; reconnect происходит после close)
      await new Promise((resolve) => {
        const onEnd = () => resolve();
        ws.once("close", onEnd);
        ws.once("error", onEnd);
      });

      // socket закрыт -> бэк офф
      reconnectAttempts++;
      const backoff = Math.min(30000, 2000 * Math.pow(1.5, reconnectAttempts));
      pushLog({ type: "reconnect_scheduled", attempt: reconnectAttempts, backoff_ms: Math.round(backoff) });
      await new Promise(r => setTimeout(r, backoff));
    } catch (e) {
      pushLog({ type: "main_loop_exception", error: String(e) });
      console.error("[MAIN EXCEPTION]", e?.message || e);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ----------------- HTTP: / , /status , /logs -----------------
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
    return;
  }

  if (req.url === "/status") {
    const connected = !!(ws && ws.readyState === WebSocket.OPEN);
    const sessionDurationMs = sessionStartTs ? (Date.now() - sessionStartTs) : 0;
    const payload = {
      ts: nowIso(),
      connected,
      channel: CHANNEL,
      session_start: sessionStartTs ? new Date(sessionStartTs).toISOString() : null,
      session_duration_ms: sessionDurationMs,
      session_duration_human: sessionDurationMs ? `${Math.round(sessionDurationMs/1000)}s` : null,
      last_pong_ts: lastPongTs ? new Date(lastPongTs).toISOString() : null,
      last_disconnect: lastDisconnect || null,
      logs_count: logs.length
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.url === "/logs") {
    // вернуть текущие логи (последние N)
    const payload = {
      ts: nowIso(),
      count: logs.length,
      tail: logs.slice(-MAX_LOG_ENTRIES)
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => {
  pushLog({ type: "http_listen", port: PORT });
  console.log("[HTTP] listening", PORT);
});

// ----------------- Периодические задачи -----------------
// heartbeat + периодический дамп метаданных (не дампим пуши)
setInterval(() => {
  const connected = !!(ws && ws.readyState === WebSocket.OPEN);
  const sessionDurationMs = sessionStartTs ? (Date.now() - sessionStartTs) : 0;
  pushLog({ type: "heartbeat", connected, session_duration_ms: sessionDurationMs, logs_count: logs.length, logs_bytes: logsBytes });
  // небольшой автосейв-маркер (файл с мета-инфой — не содержит push-данных)
  try {
    const fn = path.join(os.tmpdir(), `ws_sniffer_meta_${Date.now()}.json`);
    fs.writeFileSync(fn, JSON.stringify({ ts: nowIso(), connected, entries: logs.length }, null, 2));
    pushLog({ type: "meta_dump_saved", file: fn, entries: logs.length });
  } catch (e) {
    pushLog({ type: "meta_dump_err", error: String(e) });
  }
}, HEARTBEAT_MS);

// ----------------- Завершение -----------------
process.on("SIGINT", () => {
  pushLog({ type: "shutdown", signal: "SIGINT" });
  running = false;
  try { if (ws) ws.close(); } catch {}
  process.exit(0);
});
process.on("SIGTERM", () => {
  pushLog({ type: "shutdown", signal: "SIGTERM" });
  running = false;
  try { if (ws) ws.close(); } catch {}
  process.exit(0);
});

// ----------------- Старт -----------------
mainLoop().catch(e => {
  pushLog({ type: "fatal", error: String(e) });
  console.error("[FATAL]", e);
  process.exit(1);
});

// =============================
//       KEEP-ALIVE FOR RENDER
// =============================
const SELF_URL = process.env.RENDER_EXTERNAL_URL;

function keepAlive() {
  if (!SELF_URL) return;

  const delay = 240000 + Math.random() * 120000; // 4–6 минут

  setTimeout(async () => {
    try {
      await fetch(SELF_URL + "/healthz", {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "X-Keep-Alive": String(Math.random()),
        },
      });

      console.log("Keep-alive ping OK");
    } catch (e) {
      console.log("Keep-alive error:", e.message);
    }

    keepAlive();
  }, delay);
}

keepAlive();

