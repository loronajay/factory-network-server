// Factory Network server — bootstrap only.
//
// Real-time WebSocket multiplayer backend for JayArcade games. This file wires
// up Express + ws and delegates all behavior to focused modules:
//   src/state.mjs        in-memory state (the single source of truth)
//   src/transport.mjs    send / id + room-code helpers
//   src/matchmaking.mjs  queues, sides, match_ready
//   src/rooms.mjs        1v1 room lifecycle
//   src/lobby.mjs        generic v2 lobby lifecycle
//   src/router.mjs       WebSocket message dispatch
//   games/registry.mjs   per-game integration (lobby games + self-owning bridges)
//
// No database, no persistence — all state is intentionally ephemeral.
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

import {
  PORT,
  MAX_PLAYERS_PER_ROOM,
  MAX_LOBBY_PLAYERS,
  clients,
  rooms,
  lobbies,
  matchQueues,
} from "./src/state.mjs";
import { makeId, send } from "./src/transport.mjs";
import { handleClientMessage, handleClientDisconnect } from "./src/router.mjs";
import { startBridgeHeartbeats } from "./games/registry.mjs";

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

startBridgeHeartbeats();

// --- HTTP routes ---
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "factory-network-server",
    clients: clients.size,
    rooms: rooms.size,
    lobbies: lobbies.size,
    queues: Object.fromEntries([...matchQueues.entries()].map(([k, v]) => [k, v.length])),
    maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM,
    maxLobbyPlayers: MAX_LOBBY_PLAYERS,
  });
});

app.get("/", (req, res) => {
  res.send("Factory Network server is running.");
});

// --- WebSocket handling ---
wss.on("connection", (ws) => {
  const clientId = makeId("c_");
  clients.set(clientId, ws);

  send(ws, { event: "connected", clientId });

  ws.on("message", (raw) => handleClientMessage(clientId, ws, raw));
  ws.on("close", () => handleClientDisconnect(clientId, "disconnect"));
  ws.on("error", () => handleClientDisconnect(clientId, "error"));
});

server.listen(PORT, () => {
  console.log(`Factory Network server listening on port ${PORT}`);
});

export { app, server, wss };
