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

// --- in-memory state ---
const clients = new Map();      // clientId -> ws
const clientRooms = new Map();  // clientId -> roomCode
const rooms = new Map();        // roomCode -> Set(clientId)

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

function joinRoom(clientId, roomCode) {
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

  if (currentRoom) {
    leaveRoom(clientId, "switch_room");
  }

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
}

// --- HTTP routes ---
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "factory-network-server",
    clients: clients.size,
    rooms: rooms.size,
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
      joinRoom(clientId, roomCode);
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
    leaveRoom(clientId, "disconnect");
    clients.delete(clientId);
  });

  ws.on("error", () => {
    leaveRoom(clientId, "error");
    clients.delete(clientId);
  });
});

server.listen(PORT, () => {
  console.log(`Factory Network server listening on port ${PORT}`);
});