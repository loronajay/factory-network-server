import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";

import {
  PORT,
  MAX_PLAYERS_PER_ROOM,
  MAX_LOBBY_PLAYERS,
  clients,
  rooms,
  lobbies,
  matchQueues,
  clientSessionTokens,
} from "./state.mjs";
import { makeId, send } from "./transport.mjs";
import { handleClientMessage, handleClientDisconnect } from "./router.mjs";
import { CONNECTED_CAPABILITIES, PROTOCOL_VERSION } from "./protocol.mjs";
import { createDisconnectOnce } from "./connection-lifecycle.mjs";
import {
  createMessageRateLimiter,
  isOriginAllowed,
  parseAllowedOrigins,
} from "./connection-guard.mjs";
import { startBridgeHeartbeats, stopBridgeHeartbeats } from "../games/registry.mjs";

const DEFAULT_MAX_PAYLOAD = 256 * 1024;
const DEFAULT_MESSAGE_RATE = 240;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function createFactoryNetworkServer(options = {}) {
  const port = options.port ?? PORT;
  const maxPayload = positiveInt(options.maxPayload ?? process.env.MAX_WS_PAYLOAD_BYTES, DEFAULT_MAX_PAYLOAD);
  const messageRate = positiveInt(options.messageRate ?? process.env.MAX_WS_MESSAGES_PER_SECOND, DEFAULT_MESSAGE_RATE);
  const heartbeatIntervalMs = options.heartbeatIntervalMs === 0
    ? 0
    : positiveInt(options.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS);
  const allowedOrigins = options.allowedOrigins ?? parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
  const shouldStartBridges = options.startBridges !== false;

  const app = express();
  app.use(express.json({ limit: "32kb" }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    maxPayload,
    perMessageDeflate: false,
    verifyClient(info, done) {
      if (isOriginAllowed(info.origin, allowedOrigins)) done(true);
      else done(false, 403, "Origin not allowed");
    },
  });

  let draining = false;
  let started = false;
  let heartbeat = null;

  app.get("/live", (req, res) => {
    res.json({ ok: true, service: "factory-network-server" });
  });

  app.get("/ready", (req, res) => {
    res.status(draining ? 503 : 200).json({ ok: !draining, draining });
  });

  app.get("/health", (req, res) => {
    res.json({
      ok: !draining,
      service: "factory-network-server",
      clients: clients.size,
      rooms: rooms.size,
      lobbies: lobbies.size,
      queues: Object.fromEntries([...matchQueues.entries()].map(([key, queue]) => [key, queue.length])),
      maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM,
      maxLobbyPlayers: MAX_LOBBY_PLAYERS,
      draining,
    });
  });

  app.get("/", (req, res) => {
    res.send("Factory Network server is running.");
  });

  wss.on("connection", (ws) => {
    if (draining) {
      ws.close(1013, "Server is restarting");
      return;
    }

    let clientId = makeId("c_");
    while (clients.has(clientId)) clientId = makeId("c_");
    const connection = { clientId };
    const sessionToken = makeId("s_", 16);
    const limiter = createMessageRateLimiter({ limit: messageRate });
    const disconnect = createDisconnectOnce((reason) => handleClientDisconnect(connection.clientId, reason));

    ws.isAlive = true;
    clients.set(connection.clientId, ws);
    clientSessionTokens.set(connection.clientId, sessionToken);
    send(ws, {
      event: "connected",
      clientId: connection.clientId,
      sessionToken,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: CONNECTED_CAPABILITIES,
    });

    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", (raw) => {
      if (!limiter.take()) {
        send(ws, { event: "error", code: "RATE_LIMITED", message: "Too many messages" });
        return;
      }
      handleClientMessage(connection.clientId, ws, raw, connection);
    });
    ws.on("close", () => disconnect("disconnect"));
    ws.on("error", () => disconnect("error"));
  });

  function startHeartbeat() {
    if (!heartbeatIntervalMs || heartbeat) return;
    heartbeat = setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch { ws.terminate(); }
      }
    }, heartbeatIntervalMs);
    heartbeat.unref?.();
  }

  async function start() {
    if (started) return server.address();
    if (shouldStartBridges) startBridgeHeartbeats();
    startHeartbeat();
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port);
    });
    started = true;
    return server.address();
  }

  async function stop({ notifyClients = true } = {}) {
    if (!started) return;
    draining = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (shouldStartBridges) stopBridgeHeartbeats();

    for (const ws of wss.clients) {
      if (notifyClients) send(ws, { event: "server_restarting" });
      try { ws.close(1012, "Server restarting"); } catch { ws.terminate(); }
    }

    await new Promise((resolve) => wss.close(() => resolve()));
    await new Promise((resolve) => server.close(() => resolve()));
    started = false;
  }

  return {
    app,
    server,
    wss,
    start,
    stop,
    get draining() { return draining; },
  };
}
