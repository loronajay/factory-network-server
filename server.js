const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS_PER_ROOM = 2;
const MATCH_READY_DELAY_MS = 4000;

// --- in-memory state ---
const clients = new Map();      // clientId -> ws
const clientRooms = new Map();  // clientId -> roomCode
const rooms = new Map();        // roomCode -> Set(clientId)
const clientSides = new Map();  // clientId -> side
const matchQueues = new Map();  // gameId or gameId:side -> [clientId, ...]
const clientQueueWatch = new Map(); // clientId -> gameId

// --- helpers ---
function makeId(prefix = "") {
  return prefix + crypto.randomBytes(4).toString("hex");
}

function makeRoomCode(length = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function uniqueRoomCode() {
  let code = makeRoomCode();
  while (rooms.has(code)) code = makeRoomCode();
  return code;
}

function send(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendToClient(clientId, payload) {
  const ws = clients.get(clientId);
  if (ws) send(ws, payload);
}

function broadcastToRoom(roomCode, payload, exceptClientId = null) {
  const members = rooms.get(roomCode);
  if (!members) return;

  for (const memberId of members) {
    if (memberId === exceptClientId) continue;
    sendToClient(memberId, payload);
  }
}

function getPlayerCount(roomCode) {
  const members = rooms.get(roomCode);
  return members ? members.size : 0;
}

const SIDE_PAIRS = [
  ["boy", "girl"],
  ["alpha", "beta"],
];

function normalizeMatchSide(side) {
  if (!side || typeof side !== "string") return null;
  const s = side.trim();
  return SIDE_PAIRS.some(([a, b]) => s === a || s === b) ? s : null;
}

function getMatchQueueKey(gameId, side) {
  return side ? `${gameId}:${side}` : gameId;
}

function getOpponentMatchSide(side) {
  for (const [a, b] of SIDE_PAIRS) {
    if (side === a) return b;
    if (side === b) return a;
  }
  return null;
}

function getGameIdFromQueueKey(queueKey) {
  return String(queueKey || "").split(":")[0];
}

function getQueueCountsForGame(queues, gameId) {
  const boyQueue = queues.get(getMatchQueueKey(gameId, "boy")) || [];
  const girlQueue = queues.get(getMatchQueueKey(gameId, "girl")) || [];
  return {
    boy: boyQueue.length,
    girl: girlQueue.length,
  };
}

function shouldReceiveQueueStatus(watchedGames, clientId, gameId) {
  return watchedGames.get(clientId) === gameId;
}

function sendQueueStatus(clientId, gameId) {
  const counts = getQueueCountsForGame(matchQueues, gameId);
  sendToClient(clientId, {
    event: "queue_status",
    gameId,
    queueCounts: counts,
    boyWaiting: counts.boy,
    girlWaiting: counts.girl,
  });
}

function broadcastQueueStatus(gameId) {
  if (!gameId) return;

  for (const clientId of clients.keys()) {
    if (!shouldReceiveQueueStatus(clientQueueWatch, clientId, gameId)) continue;
    sendQueueStatus(clientId, gameId);
  }
}

function claimQueuedOpponent(queues, gameId, side) {
  const opponentSide = getOpponentMatchSide(side);
  const queueKey = getMatchQueueKey(gameId, opponentSide);
  const queue = queues.get(queueKey) || [];
  if (queue.length === 0) return null;

  const opponentId = queue.shift();
  if (queue.length === 0) queues.delete(queueKey);
  return opponentId;
}

function enqueueMatchClient(queues, gameId, side, clientId) {
  const queueKey = getMatchQueueKey(gameId, side);
  const queue = queues.get(queueKey) || [];
  queue.push(clientId);
  queues.set(queueKey, queue);
}

function makeMatchSeed() {
  return crypto.randomBytes(4).readUInt32BE(0);
}

function buildMatchReadyMessages(clientAId, sideA, clientBId, sideB, serverNow = Date.now(), startDelayMs = MATCH_READY_DELAY_MS, seed = makeMatchSeed()) {
  const normalizedA = normalizeMatchSide(sideA);
  const normalizedB = normalizeMatchSide(sideB);
  if (!normalizedA || !normalizedB || normalizedA === normalizedB) return null;

  const startAt = serverNow + startDelayMs;
  return [
    {
      clientId: clientAId,
      payload: { event: "match_ready", seed, serverNow, startAt, remoteSide: normalizedB }
    },
    {
      clientId: clientBId,
      payload: { event: "match_ready", seed, serverNow, startAt, remoteSide: normalizedA }
    },
  ];
}

function setClientSide(clientId, side) {
  const normalized = normalizeMatchSide(side);
  if (normalized) clientSides.set(clientId, normalized);
  else clientSides.delete(clientId);
  return normalized;
}

function getRoomMemberIds(roomCode) {
  const members = rooms.get(roomCode);
  return members ? [...members] : [];
}

function sameSideAlreadyInRoom(roomCode, side) {
  const normalized = normalizeMatchSide(side);
  if (!normalized) return false;
  return getRoomMemberIds(roomCode).some(memberId => clientSides.get(memberId) === normalized);
}

function emitMatchReady(roomCode) {
  const [clientAId, clientBId] = getRoomMemberIds(roomCode);
  if (!clientAId || !clientBId) return false;

  const messages = buildMatchReadyMessages(
    clientAId,
    clientSides.get(clientAId),
    clientBId,
    clientSides.get(clientBId),
  );
  if (!messages) return false;

  for (const { clientId, payload } of messages) {
    sendToClient(clientId, { ...payload, roomCode });
  }
  return true;
}

function leaveQueue(clientId) {
  for (const [queueKey, queue] of matchQueues) {
    const i = queue.indexOf(clientId);
    if (i !== -1) {
      queue.splice(i, 1);
      if (queue.length === 0) matchQueues.delete(queueKey);
      return queueKey;
    }
  }
  return null;
}

function leaveRoom(clientId, reason = "left") {
  const roomCode = clientRooms.get(clientId);
  if (!roomCode) return;

  const members = rooms.get(roomCode);
  if (members) {
    members.delete(clientId);

    broadcastToRoom(roomCode, {
      event: "player_left",
      clientId,
      roomCode,
      playerCount: members.size,
      reason
    });

    if (members.size === 0) {
      rooms.delete(roomCode);
    }
  }

  clientRooms.delete(clientId);

  sendToClient(clientId, {
    event: "room_left",
    roomCode
  });
}

function joinRoom(clientId, roomCode, side) {
  if (!roomCode || !rooms.has(roomCode)) {
    sendToClient(clientId, {
      event: "error",
      code: "ROOM_NOT_FOUND",
      message: "Room does not exist"
    });
    return;
  }

  const currentRoom = clientRooms.get(clientId);
  if (currentRoom === roomCode) {
    sendToClient(clientId, {
      event: "room_joined",
      roomCode,
      playerCount: getPlayerCount(roomCode)
    });
    return;
  }

  const members = rooms.get(roomCode);

  if (members.size >= MAX_PLAYERS_PER_ROOM) {
    sendToClient(clientId, {
      event: "error",
      code: "ROOM_FULL",
      message: "Room is full"
    });
    return;
  }

  if (sameSideAlreadyInRoom(roomCode, side)) {
    sendToClient(clientId, {
      event: "error",
      code: "SIDE_CONFLICT",
      message: "That side is already taken in this room"
    });
    return;
  }

  if (currentRoom) {
    leaveRoom(clientId, "switch_room");
  }

  setClientSide(clientId, side);
  members.add(clientId);
  clientRooms.set(clientId, roomCode);

  sendToClient(clientId, {
    event: "room_joined",
    roomCode,
    playerCount: members.size
  });

  broadcastToRoom(roomCode, {
    event: "player_joined",
    clientId,
    roomCode,
    playerCount: members.size
  }, clientId);

  emitMatchReady(roomCode);
}

// --- HTTP routes ---
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "factory-network-server",
    clients: clients.size,
    rooms: rooms.size,
    queues: Object.fromEntries([...matchQueues.entries()].map(([k, v]) => [k, v.length])),
    maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM
  });
});

app.get("/", (req, res) => {
  res.send("Factory Network server is running.");
});

// --- WebSocket handling ---
wss.on("connection", (ws) => {
  const clientId = makeId("c_");
  clients.set(clientId, ws);

  send(ws, {
    event: "connected",
    clientId
  });

  ws.on("message", (raw) => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      send(ws, {
        event: "error",
        code: "BAD_JSON",
        message: "Invalid JSON"
      });
      return;
    }

    const type = data.type;

    if (type === "create_room") {
      const currentRoom = clientRooms.get(clientId);
      if (currentRoom) leaveRoom(clientId, "create_new_room");
      setClientSide(clientId, data.side);

      const roomCode = uniqueRoomCode();
      const members = new Set([clientId]);
      rooms.set(roomCode, members);
      clientRooms.set(clientId, roomCode);

      send(ws, {
        event: "room_joined",
        roomCode,
        playerCount: 1,
        created: true
      });
      return;
    }

    if (type === "join_room") {
      const roomCode = String(data.roomCode || "").trim().toUpperCase();
      joinRoom(clientId, roomCode, data.side);
      return;
    }

    if (type === "leave_room") {
      leaveRoom(clientId, "left");
      return;
    }

    if (type === "room_message") {
      const roomCode = clientRooms.get(clientId);
      if (!roomCode) {
        send(ws, {
          event: "error",
          code: "NOT_IN_ROOM",
          message: "You are not in a room"
        });
        return;
      }

      const messageType = String(data.messageType || "");
      const value = String(data.value ?? "");

      broadcastToRoom(roomCode, {
        event: "message",
        scope: "room",
        messageType,
        value,
        senderId: clientId,
        roomCode
      });
      return;
    }

    if (type === "direct_message") {
      const targetId = String(data.targetId || "");
      const messageType = String(data.messageType || "");
      const value = String(data.value ?? "");

      if (!clients.has(targetId)) {
        send(ws, {
          event: "error",
          code: "CLIENT_NOT_FOUND",
          message: "Target client does not exist"
        });
        return;
      }

      sendToClient(targetId, {
        event: "message",
        scope: "direct",
        messageType,
        value,
        senderId: clientId
      });
      return;
    }

    if (type === "find_match") {
      const gameId = String(data.gameId || "default");
      const side = setClientSide(clientId, data.side);
      clientQueueWatch.set(clientId, gameId);
      const currentRoom = clientRooms.get(clientId);
      if (currentRoom) leaveRoom(clientId, "find_match");
      const removedQueueKey = leaveQueue(clientId);
      if (removedQueueKey) broadcastQueueStatus(getGameIdFromQueueKey(removedQueueKey));

      const opponentId = claimQueuedOpponent(matchQueues, gameId, side);
      if (opponentId) {
        broadcastQueueStatus(gameId);

        const roomCode = uniqueRoomCode();
        rooms.set(roomCode, new Set([opponentId, clientId]));
        clientRooms.set(opponentId, roomCode);
        clientRooms.set(clientId, roomCode);

        sendToClient(opponentId, { event: "room_joined", roomCode, playerCount: 2 });
        sendToClient(clientId,   { event: "room_joined", roomCode, playerCount: 2 });
        sendToClient(opponentId, { event: "player_joined", clientId,             roomCode, playerCount: 2 });
        sendToClient(clientId,   { event: "player_joined", clientId: opponentId, roomCode, playerCount: 2 });
        emitMatchReady(roomCode);
      } else {
        enqueueMatchClient(matchQueues, gameId, side, clientId);
        broadcastQueueStatus(gameId);
        send(ws, { event: "searching", gameId, ...(side ? { side } : {}) });
      }
      return;
    }

    if (type === "queue_status") {
      const gameId = String(data.gameId || "default");
      clientQueueWatch.set(clientId, gameId);
      sendQueueStatus(clientId, gameId);
      return;
    }

    if (type === "cancel_match") {
      const removedQueueKey = leaveQueue(clientId);
      if (removedQueueKey) broadcastQueueStatus(getGameIdFromQueueKey(removedQueueKey));
      send(ws, { event: "search_cancelled" });
      return;
    }

    if (type === "ping") {
      send(ws, { event: "pong" });
      return;
    }

    send(ws, {
      event: "error",
      code: "UNKNOWN_TYPE",
      message: "Unknown message type"
    });
  });

  ws.on("close", () => {
    const removedQueueKey = leaveQueue(clientId);
    if (removedQueueKey) broadcastQueueStatus(getGameIdFromQueueKey(removedQueueKey));
    leaveRoom(clientId, "disconnect");
    clientSides.delete(clientId);
    clientQueueWatch.delete(clientId);
    clients.delete(clientId);
  });

  ws.on("error", () => {
    const removedQueueKey = leaveQueue(clientId);
    if (removedQueueKey) broadcastQueueStatus(getGameIdFromQueueKey(removedQueueKey));
    leaveRoom(clientId, "error");
    clientSides.delete(clientId);
    clientQueueWatch.delete(clientId);
    clients.delete(clientId);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Factory Network server listening on port ${PORT}`);
  });
}

module.exports = {
  normalizeMatchSide,
  getMatchQueueKey,
  claimQueuedOpponent,
  enqueueMatchClient,
  buildMatchReadyMessages,
  getQueueCountsForGame,
  shouldReceiveQueueStatus,
};
