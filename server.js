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

// Parallel lobby protocol for 2-6 player games such as Echo Duel.
// Existing room/matchmaking protocol stays 1v1 for Lovers Lost/Battleshits.
const MAX_LOBBY_PLAYERS = 6;
const DEFAULT_LOBBY_MIN_PLAYERS = 2;
const DEFAULT_LOBBY_MAX_PLAYERS = 6;
const DEFAULT_LOBBY_COUNTDOWN_MS = 20000;
const LOBBY_START_DELAY_MS = 4000;

// --- in-memory state ---
const clients = new Map();      // clientId -> ws
const clientRooms = new Map();  // clientId -> roomCode
const rooms = new Map();        // roomCode -> Set(clientId)
const clientSides = new Map();  // clientId -> side
const matchQueues = new Map();  // gameId or gameId:side -> [clientId, ...]
const clientQueueWatch = new Map(); // clientId -> gameId

// --- v2 lobby state ---
const lobbies = new Map();       // roomCode -> lobby
const clientLobbies = new Map(); // clientId -> roomCode

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
  while (rooms.has(code) || lobbies.has(code)) code = makeRoomCode();
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

  leaveLobby(clientId, "join_room");

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


// --- v2 lobby helpers ---
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function sanitizeLobbyGameId(value) {
  const gameId = typeof value === "string" ? value.trim() : "";
  return gameId || "default";
}

function sanitizePenaltyWord(value) {
  const word = typeof value === "string" ? value.trim().toUpperCase() : "";
  const lettersOnly = word.replace(/[^A-Z]/g, "");
  if (lettersOnly.length < 4 || lettersOnly.length > 10) return "ECHO";
  return lettersOnly;
}

function sanitizeLobbySettings(settings = {}) {
  return {
    penaltyWord: sanitizePenaltyWord(settings.penaltyWord || "ECHO"),
  };
}

function sanitizeLobbyLimits(minPlayers, maxPlayers) {
  const max = clampInt(maxPlayers, 2, MAX_LOBBY_PLAYERS, DEFAULT_LOBBY_MAX_PLAYERS);
  const min = clampInt(minPlayers, 2, max, Math.min(DEFAULT_LOBBY_MIN_PLAYERS, max));
  return { minPlayers: min, maxPlayers: max };
}

function getLobbyMemberIds(roomCode) {
  const lobby = lobbies.get(roomCode);
  return lobby ? [...lobby.members] : [];
}

function lobbyPlayerCount(lobby) {
  return lobby?.members?.size || 0;
}

function buildLobbyPayload(lobby) {
  return {
    roomCode: lobby.roomCode,
    gameId: lobby.gameId,
    ownerId: lobby.ownerId,
    playerCount: lobbyPlayerCount(lobby),
    minPlayers: lobby.minPlayers,
    maxPlayers: lobby.maxPlayers,
    status: lobby.status,
    isPrivate: !!lobby.isPrivate,
    settings: lobby.settings,
    members: getLobbyMemberIds(lobby.roomCode),
    startAt: lobby.startAt || null,
  };
}

function sendLobbyUpdated(lobby) {
  if (!lobby) return;
  broadcastToLobby(lobby.roomCode, {
    event: "lobby_updated",
    ...buildLobbyPayload(lobby),
  });
}

function broadcastToLobby(roomCode, payload, exceptClientId = null) {
  const lobby = lobbies.get(roomCode);
  if (!lobby) return;

  for (const memberId of lobby.members) {
    if (memberId === exceptClientId) continue;
    sendToClient(memberId, payload);
  }
}

function clearLobbyCountdown(lobby) {
  if (!lobby) return;
  if (lobby.countdownTimer) clearTimeout(lobby.countdownTimer);
  lobby.countdownTimer = null;
  lobby.startAt = null;
  if (lobby.status === "countdown") lobby.status = "open";
}

function startLobby(lobby, reason = "manual") {
  if (!lobby || lobby.status === "started") return false;
  if (lobbyPlayerCount(lobby) < lobby.minPlayers) return false;

  clearLobbyCountdown(lobby);
  lobby.status = "started";
  lobby.seed = makeMatchSeed();

  const serverNow = Date.now();
  const startAt = serverNow + LOBBY_START_DELAY_MS;
  lobby.startAt = startAt;

  broadcastToLobby(lobby.roomCode, {
    event: "lobby_started",
    roomCode: lobby.roomCode,
    gameId: lobby.gameId,
    seed: lobby.seed,
    serverNow,
    startAt,
    reason,
    ownerId: lobby.ownerId,
    members: getLobbyMemberIds(lobby.roomCode),
    settings: lobby.settings,
  });
  return true;
}

function maybeStartLobbyCountdown(lobby) {
  if (!lobby || lobby.status === "started") return;
  const count = lobbyPlayerCount(lobby);

  if (count >= lobby.maxPlayers) {
    startLobby(lobby, "max_players");
    return;
  }

  if (count < lobby.minPlayers) {
    clearLobbyCountdown(lobby);
    sendLobbyUpdated(lobby);
    return;
  }

  if (lobby.status === "countdown" && lobby.countdownTimer) return;

  lobby.status = "countdown";
  lobby.startAt = Date.now() + lobby.countdownMs;
  lobby.countdownTimer = setTimeout(() => {
    lobby.countdownTimer = null;
    if (!lobbies.has(lobby.roomCode)) return;
    if (lobbyPlayerCount(lobby) >= lobby.minPlayers) {
      startLobby(lobby, "countdown");
    } else {
      lobby.status = "open";
      lobby.startAt = null;
      sendLobbyUpdated(lobby);
    }
  }, lobby.countdownMs);

  broadcastToLobby(lobby.roomCode, {
    event: "lobby_countdown_started",
    ...buildLobbyPayload(lobby),
  });
}

function leaveLobby(clientId, reason = "left") {
  const roomCode = clientLobbies.get(clientId);
  if (!roomCode) return;

  const lobby = lobbies.get(roomCode);
  if (!lobby) {
    clientLobbies.delete(clientId);
    return;
  }

  lobby.members.delete(clientId);
  clientLobbies.delete(clientId);

  sendToClient(clientId, {
    event: "lobby_left",
    roomCode,
  });

  if (lobby.members.size === 0) {
    clearLobbyCountdown(lobby);
    lobbies.delete(roomCode);
    return;
  }

  if (lobby.ownerId === clientId) {
    lobby.ownerId = [...lobby.members][0];
  }

  broadcastToLobby(roomCode, {
    event: "lobby_player_left",
    clientId,
    roomCode,
    playerCount: lobby.members.size,
    ownerId: lobby.ownerId,
    reason,
  });

  maybeStartLobbyCountdown(lobby);
  sendLobbyUpdated(lobby);
}

function createLobby(clientId, data = {}, { isPrivate = false } = {}) {
  leaveQueue(clientId);
  leaveRoom(clientId, "create_lobby");
  leaveLobby(clientId, "create_new_lobby");

  const roomCode = uniqueRoomCode();
  const limits = sanitizeLobbyLimits(data.minPlayers, data.maxPlayers);
  const lobby = {
    roomCode,
    gameId: sanitizeLobbyGameId(data.gameId),
    ownerId: clientId,
    members: new Set([clientId]),
    minPlayers: limits.minPlayers,
    maxPlayers: limits.maxPlayers,
    settings: sanitizeLobbySettings(data.settings),
    isPrivate: !!isPrivate,
    status: "open",
    countdownMs: clampInt(data.countdownMs, 5000, 60000, DEFAULT_LOBBY_COUNTDOWN_MS),
    countdownTimer: null,
    startAt: null,
    seed: null,
    createdAt: Date.now(),
  };

  lobbies.set(roomCode, lobby);
  clientLobbies.set(clientId, roomCode);

  sendToClient(clientId, {
    event: "lobby_joined",
    created: true,
    clientId,
    ...buildLobbyPayload(lobby),
  });

  return lobby;
}

function joinLobby(clientId, roomCode) {
  const code = String(roomCode || "").trim().toUpperCase();
  const lobby = lobbies.get(code);

  if (!lobby) {
    sendToClient(clientId, {
      event: "error",
      code: "LOBBY_NOT_FOUND",
      message: "Lobby does not exist"
    });
    return null;
  }

  if (lobby.status === "started") {
    sendToClient(clientId, {
      event: "error",
      code: "LOBBY_STARTED",
      message: "Lobby has already started"
    });
    return null;
  }

  if (lobby.members.size >= lobby.maxPlayers) {
    sendToClient(clientId, {
      event: "error",
      code: "LOBBY_FULL",
      message: "Lobby is full"
    });
    return null;
  }

  leaveQueue(clientId);
  leaveRoom(clientId, "join_lobby");
  leaveLobby(clientId, "switch_lobby");

  lobby.members.add(clientId);
  clientLobbies.set(clientId, code);

  sendToClient(clientId, {
    event: "lobby_joined",
    created: false,
    clientId,
    ...buildLobbyPayload(lobby),
  });

  broadcastToLobby(code, {
    event: "lobby_player_joined",
    clientId,
    roomCode: code,
    playerCount: lobby.members.size,
    ownerId: lobby.ownerId,
  }, clientId);

  maybeStartLobbyCountdown(lobby);
  sendLobbyUpdated(lobby);
  return lobby;
}

function findOpenLobby(gameId) {
  const targetGameId = sanitizeLobbyGameId(gameId);
  let best = null;

  for (const lobby of lobbies.values()) {
    if (lobby.gameId !== targetGameId) continue;
    if (lobby.isPrivate) continue;
    if (lobby.status === "started") continue;
    if (lobby.members.size >= lobby.maxPlayers) continue;
    if (!best || lobby.createdAt < best.createdAt) best = lobby;
  }

  return best;
}

function updateLobbySettings(clientId, data = {}) {
  const roomCode = clientLobbies.get(clientId);
  const lobby = lobbies.get(roomCode);

  if (!lobby) {
    sendToClient(clientId, {
      event: "error",
      code: "NOT_IN_LOBBY",
      message: "You are not in a lobby"
    });
    return;
  }

  if (lobby.ownerId !== clientId) {
    sendToClient(clientId, {
      event: "error",
      code: "NOT_LOBBY_OWNER",
      message: "Only the lobby owner can update settings"
    });
    return;
  }

  if (lobby.status === "started") {
    sendToClient(clientId, {
      event: "error",
      code: "LOBBY_STARTED",
      message: "Lobby has already started"
    });
    return;
  }

  const limits = sanitizeLobbyLimits(
    data.minPlayers ?? lobby.minPlayers,
    data.maxPlayers ?? lobby.maxPlayers
  );

  lobby.minPlayers = limits.minPlayers;
  lobby.maxPlayers = limits.maxPlayers;
  lobby.settings = sanitizeLobbySettings({
    ...lobby.settings,
    ...(data.settings || {}),
  });

  maybeStartLobbyCountdown(lobby);
  sendLobbyUpdated(lobby);
}

function requestStartLobby(clientId) {
  const roomCode = clientLobbies.get(clientId);
  const lobby = lobbies.get(roomCode);

  if (!lobby) {
    sendToClient(clientId, {
      event: "error",
      code: "NOT_IN_LOBBY",
      message: "You are not in a lobby"
    });
    return;
  }

  if (lobby.ownerId !== clientId) {
    sendToClient(clientId, {
      event: "error",
      code: "NOT_LOBBY_OWNER",
      message: "Only the lobby owner can start the match"
    });
    return;
  }

  if (!startLobby(lobby, "owner_start")) {
    sendToClient(clientId, {
      event: "error",
      code: "LOBBY_NOT_READY",
      message: "Lobby does not have enough players"
    });
  }
}

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
    maxLobbyPlayers: MAX_LOBBY_PLAYERS
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

    if (type === "create_lobby") {
      createLobby(clientId, data, { isPrivate: !!data.private });
      return;
    }

    if (type === "join_lobby") {
      joinLobby(clientId, data.roomCode);
      return;
    }

    if (type === "find_lobby") {
      const gameId = sanitizeLobbyGameId(data.gameId);
      const existing = findOpenLobby(gameId);
      if (existing) {
        joinLobby(clientId, existing.roomCode);
      } else {
        createLobby(clientId, {
          ...data,
          gameId,
          settings: data.settings || { penaltyWord: "ECHO" },
        }, { isPrivate: false });
      }
      return;
    }

    if (type === "update_lobby_settings") {
      updateLobbySettings(clientId, data);
      return;
    }

    if (type === "start_lobby") {
      requestStartLobby(clientId);
      return;
    }

    if (type === "leave_lobby") {
      leaveLobby(clientId, "left");
      return;
    }

    if (type === "lobby_message") {
      const roomCode = clientLobbies.get(clientId);
      if (!roomCode) {
        send(ws, {
          event: "error",
          code: "NOT_IN_LOBBY",
          message: "You are not in a lobby"
        });
        return;
      }

      const messageType = String(data.messageType || "");
      const value = String(data.value ?? "");

      broadcastToLobby(roomCode, {
        event: "message",
        scope: "lobby",
        messageType,
        value,
        senderId: clientId,
        roomCode
      });
      return;
    }

    if (type === "create_room") {
      const currentRoom = clientRooms.get(clientId);
      if (currentRoom) leaveRoom(clientId, "create_new_room");
      leaveLobby(clientId, "create_room");
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
      leaveLobby(clientId, "find_match");
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
    leaveLobby(clientId, "disconnect");
    clientSides.delete(clientId);
    clientQueueWatch.delete(clientId);
    clients.delete(clientId);
  });

  ws.on("error", () => {
    const removedQueueKey = leaveQueue(clientId);
    if (removedQueueKey) broadcastQueueStatus(getGameIdFromQueueKey(removedQueueKey));
    leaveRoom(clientId, "error");
    leaveLobby(clientId, "error");
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
  sanitizePenaltyWord,
  sanitizeLobbyLimits,
  buildLobbyPayload,
};
