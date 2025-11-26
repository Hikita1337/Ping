const WebSocket = require("ws");
const http = require("http");

// Конфиг
const WS_URL = "wss://ws.cs2run.app/connection/websocket";
const CHANNEL = "csgorun:crash";
const PORT = 10000;
const TOKEN_URL = "https://cs2run.app/api/v1/auth/guest";

// Логи в памяти
const logs = [];
const MAX_LOGS = 2000;

// Данные текущей сессии
let sessionStart = null;
let lastPong = null;
let ws = null;

// Функция логирования
function addLog(event, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...extra
  };

  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();

  console.log(`[${event}]`, extra);
}

// Получение guest токена
async function fetchToken() {
  addLog("token_fetch");
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const json = await res.json();
    return json?.data?.token;
  } catch (e) {
    addLog("token_error", { error: e.message });
    return null;
  }
}

// Подключение WebSocket
async function connectWS() {
  const token = await fetchToken();
  if (!token) return setTimeout(connectWS, 5000);

  addLog("start_connect", { ws_url: WS_URL, channel: CHANNEL });

  ws = new WebSocket(WS_URL, {
    headers: {
      "Authorization": `Bearer ${token}`
    }
  });

  ws.on("open", () => {
    sessionStart = Date.now();
    lastPong = Date.now();
    addLog("ws_open");

    ws.send(JSON.stringify({
      id: 1,
      connect: { version: "6.3.1 OSS" }
    }));

    ws.send(JSON.stringify({
      id: 100,
      subscribe: CHANNEL
    }));
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);

      // ПИНГ сервера приходит в виде пустого {}
      if (Object.keys(msg).length === 0) {
        lastPong = Date.now();
        addLog("pong_recv");

        ws.send(JSON.stringify({ type: 3 })); // PONG клиентский
        return;
      }

      if (msg.error) {
        addLog("error", msg.error);
        return;
      }

      // Игнорируем PUSH от краш-канала
      if (msg.result || msg.push) {
        return;
      }

      addLog("msg", msg);
    } catch {}
  });

  ws.on("close", (code, reason) => {
    const durationMs = sessionStart ? Date.now() - sessionStart : 0;
    addLog("ws_close", {
      code,
      reason: reason?.toString(),
      duration_ms: durationMs,
      duration_human: `${Math.round(durationMs / 1000)}s`
    });

    setTimeout(connectWS, 3000);
  });

  ws.on("error", err => {
    addLog("ws_error", { error: err.toString() });
  });
}

// HTTP endpoints
const server = http.createServer((req, res) => {
  if (req.url === "/logs") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ count: logs.length, logs }, null, 2));
  }

  if (req.url === "/status") {
    const duration = sessionStart ? Math.floor((Date.now() - sessionStart) / 1000) : 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      connected: ws?.readyState === WebSocket.OPEN,
      session_seconds: duration,
      last_pong_seconds_ago: lastPong ? Math.floor((Date.now() - lastPong) / 1000) : null
    }, null, 2));
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("WS Monitor OK");
});

server.listen(PORT, () => {
  addLog("http_listen", { port: PORT });
  connectWS();
});