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

function sanitizeLobbyIdentity(identity = {}) {
  if (!identity || typeof identity !== "object") return null;
  const displayName = sanitizeEchoDisplayName(identity.displayName || "", "");
  const playerId = typeof identity.playerId === "string" ? identity.playerId.trim() : "";
  if (!displayName && !playerId) return null;
  return {
    playerId,
    displayName,
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

function isLobbyJoinable(lobby) {
  if (!lobby) return false;
  return lobby.status === "open" && lobbyPlayerCount(lobby) < lobby.maxPlayers;
}

function canLobbyStart(lobby) {
  if (!lobby) return false;
  return lobby.status === "open" && lobbyPlayerCount(lobby) >= lobby.minPlayers;
}

function canLobbyOwnerUpdateSettings(lobby) {
  if (!lobby) return false;
  return lobby.status === "open";
}

function rememberLobbyIdentity(lobby, clientId, identity) {
  if (!lobby || !clientId) return;
  const sanitized = sanitizeLobbyIdentity(identity);
  if (!sanitized) return;
  if (!(lobby.memberProfiles instanceof Map)) lobby.memberProfiles = new Map();
  lobby.memberProfiles.set(clientId, sanitized);
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
    members: lobby?.members ? [...lobby.members] : getLobbyMemberIds(lobby.roomCode),
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

function clearEchoMatchTimer(lobby) {
  if (!lobby) return;
  if (lobby.echoMatchTimer) clearTimeout(lobby.echoMatchTimer);
  lobby.echoMatchTimer = null;
}

function isEchoDuelLobby(lobby) {
  return lobby?.gameId === "echo-duel";
}

function isEchoLobbyMatchPendingStart(lobby, now = Date.now()) {
  return isEchoDuelLobby(lobby)
    && !!lobby?.echoMatch
    && lobby?.status === "started"
    && Number(lobby?.startAt || 0) > now;
}

function cancelEchoLobbyStart(lobby) {
  if (!lobby) return lobby;
  clearEchoMatchTimer(lobby);
  lobby.echoMatch = null;
  lobby.echoSyncSeq = 0;
  lobby.status = "open";
  lobby.startAt = null;
  lobby.seed = null;
  return lobby;
}

function shouldSendGenericLobbyUpdateAfterLeave(lobby) {
  if (!lobby) return false;
  return !(isEchoDuelLobby(lobby) && lobby.echoMatch);
}

function serializeEchoMatchState(match, lobby, now = Date.now()) {
  const snapshot = cloneEchoMatch(match);
  delete snapshot.inputCursor;
  if (snapshot.timer) {
    snapshot.timer = {
      durationMs: snapshot.timer.durationMs,
      remainingMs: Math.max(0, snapshot.timer.endsAt - now),
    };
  }
  if (snapshot.playback) {
    snapshot.playback = {
      ...snapshot.playback,
      sequence: [...(snapshot.playback.sequence || [])],
      remainingMs: Math.max(0, snapshot.playback.endsAt - now),
    };
    delete snapshot.playback.endsAt;
  }
  snapshot.mode = "online";
  snapshot.network = {
    roomCode: lobby?.roomCode || match.roomCode,
    hostId: lobby?.ownerId || null,
    lobbyOwnerId: lobby?.ownerId || null,
    authorityMode: "server",
    syncSeq: Number(lobby?.echoSyncSeq || 0),
  };
  return snapshot;
}

function buildLobbyStartedPayload(lobby, serverNow = Date.now(), reason = "manual") {
  const payload = {
    event: "lobby_started",
    roomCode: lobby.roomCode,
    gameId: lobby.gameId,
    seed: lobby.seed,
    serverNow,
    startAt: lobby.startAt,
    reason,
    ownerId: lobby.ownerId,
    members: lobby?.members ? [...lobby.members] : getLobbyMemberIds(lobby.roomCode),
    settings: lobby.settings,
  };

  if (isEchoDuelLobby(lobby) && lobby.echoMatch) {
    payload.authorityMode = "server";
    payload.matchState = serializeEchoMatchState(lobby.echoMatch, lobby, serverNow);
  }

  return payload;
}

function getEchoAuthorityMessageType(match) {
  if (!match) return "match_state";
  if (match.phase === ECHO_PHASES.SIGNAL_PLAYBACK) return "signal_playback";
  if (match.phase === ECHO_PHASES.MATCH_OVER) return "match_ended";
  return "match_state";
}

function broadcastEchoMatchState(lobby, messageType = null) {
  if (!lobby?.echoMatch) return;
  lobby.echoSyncSeq = Number(lobby.echoSyncSeq || 0) + 1;
  const snapshot = serializeEchoMatchState(lobby.echoMatch, lobby, Date.now());
  broadcastToLobby(lobby.roomCode, {
    event: "message",
    scope: "lobby",
    messageType: messageType || getEchoAuthorityMessageType(lobby.echoMatch),
    value: JSON.stringify(snapshot),
    senderId: "server",
    roomCode: lobby.roomCode,
  });
}

function nextEchoMatchDeadline(match) {
  if (!match) return null;
  if (match.phase === ECHO_PHASES.SIGNAL_PLAYBACK && match.playback?.endsAt) {
    return match.playback.endsAt;
  }
  if (match.timer?.endsAt) return match.timer.endsAt;
  return null;
}

function syncLobbyStatusFromEchoMatch(lobby) {
  if (!lobby?.echoMatch) return;
  lobby.status = lobby.echoMatch.phase === ECHO_PHASES.MATCH_OVER ? "ended" : "started";
}

function scheduleEchoMatchTimer(lobby) {
  clearEchoMatchTimer(lobby);
  if (!lobby?.echoMatch || lobby.echoMatch.phase === ECHO_PHASES.MATCH_OVER) return;

  const deadline = nextEchoMatchDeadline(lobby.echoMatch);
  if (!Number.isFinite(deadline)) return;

  const delay = Math.max(0, deadline - Date.now());
  lobby.echoMatchTimer = setTimeout(() => {
    if (!lobbies.has(lobby.roomCode) || !lobby.echoMatch) return;
    const next = advanceEchoMatchToTime(lobby.echoMatch, Date.now());
    if (next !== lobby.echoMatch) {
      lobby.echoMatch = next;
      syncLobbyStatusFromEchoMatch(lobby);
      broadcastEchoMatchState(lobby);
      if (lobby.status === "ended") sendLobbyUpdated(lobby);
    }
    scheduleEchoMatchTimer(lobby);
  }, delay);
}

function handleEchoLobbyInput(lobby, clientId, value) {
  if (!lobby?.echoMatch) return false;
  let parsed = null;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }

  const input = String(parsed?.input || "").toUpperCase();
  const next = applyEchoInputToMatch(
    lobby.echoMatch,
    clientId,
    input,
    { turnId: parsed?.turnId, phaseId: parsed?.phaseId },
    Date.now()
  );
  if (next === lobby.echoMatch) return false;

  lobby.echoMatch = next;
  syncLobbyStatusFromEchoMatch(lobby);
  broadcastEchoMatchState(lobby);
  if (lobby.status === "ended") sendLobbyUpdated(lobby);
  scheduleEchoMatchTimer(lobby);
  return true;
}

function startLobby(lobby, reason = "manual") {
  if (!canLobbyStart(lobby)) return false;

  clearLobbyCountdown(lobby);
  clearEchoMatchTimer(lobby);
  lobby.status = "started";
  lobby.seed = makeMatchSeed();

  const serverNow = Date.now();
  const startAt = serverNow + LOBBY_START_DELAY_MS;
  lobby.startAt = startAt;

  if (isEchoDuelLobby(lobby)) {
    lobby.echoSyncSeq = 0;
    lobby.echoMatch = createEchoDuelMatchState(lobby, startAt);
    syncLobbyStatusFromEchoMatch(lobby);
  }

  broadcastToLobby(lobby.roomCode, buildLobbyStartedPayload(lobby, serverNow, reason));
  if (isEchoDuelLobby(lobby)) scheduleEchoMatchTimer(lobby);
  return true;
}

function maybeStartLobbyCountdown(lobby) {
  if (!lobby) return;
  clearLobbyCountdown(lobby);
  sendLobbyUpdated(lobby);
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
  if (lobby.memberProfiles instanceof Map) lobby.memberProfiles.delete(clientId);

  sendToClient(clientId, {
    event: "lobby_left",
    roomCode,
  });

  if (lobby.members.size === 0) {
    clearLobbyCountdown(lobby);
    clearEchoMatchTimer(lobby);
    lobbies.delete(roomCode);
    return;
  }

  if (lobby.ownerId === clientId) {
    lobby.ownerId = [...lobby.members][0];
  }

  if (isEchoLobbyMatchPendingStart(lobby, Date.now())) {
    cancelEchoLobbyStart(lobby);
  }

  let echoMatchChanged = false;
  if (isEchoDuelLobby(lobby) && lobby.echoMatch) {
    const nextMatch = applyEchoDisconnectToMatch(lobby.echoMatch, clientId, Date.now());
    if (nextMatch !== lobby.echoMatch) {
      lobby.echoMatch = nextMatch;
      syncLobbyStatusFromEchoMatch(lobby);
      echoMatchChanged = true;
    }
  }

  broadcastToLobby(roomCode, {
    event: "lobby_player_left",
    clientId,
    roomCode,
    playerCount: lobby.members.size,
    ownerId: lobby.ownerId,
    reason,
  });

  if (echoMatchChanged) {
    broadcastEchoMatchState(lobby);
    if (lobby.status === "ended") sendLobbyUpdated(lobby);
    scheduleEchoMatchTimer(lobby);
  }

  if (shouldSendGenericLobbyUpdateAfterLeave(lobby)) {
    maybeStartLobbyCountdown(lobby);
    sendLobbyUpdated(lobby);
  }
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
    memberProfiles: new Map(),
    minPlayers: limits.minPlayers,
    maxPlayers: limits.maxPlayers,
    settings: sanitizeLobbySettings(data.settings),
    isPrivate: !!isPrivate,
    status: "open",
    countdownMs: clampInt(data.countdownMs, 5000, 60000, DEFAULT_LOBBY_COUNTDOWN_MS),
    countdownTimer: null,
    startAt: null,
    seed: null,
    echoMatch: null,
    echoMatchTimer: null,
    echoSyncSeq: 0,
    createdAt: Date.now(),
  };
  rememberLobbyIdentity(lobby, clientId, data.identity);

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

function joinLobby(clientId, roomCode, identity = null) {
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

  if (lobby.status !== "open") {
    sendToClient(clientId, {
      event: "error",
      code: lobby.status === "started" ? "LOBBY_STARTED" : "LOBBY_NOT_JOINABLE",
      message: lobby.status === "started" ? "Lobby has already started" : "Lobby is not joinable"
    });
    return null;
  }

  if (!isLobbyJoinable(lobby)) {
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
  rememberLobbyIdentity(lobby, clientId, identity);

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
    if (!isLobbyJoinable(lobby)) continue;
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

  if (!canLobbyOwnerUpdateSettings(lobby)) {
    sendToClient(clientId, {
      event: "error",
      code: "LOBBY_LOCKED",
      message: "Lobby settings are locked once startup begins"
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

  if (!canLobbyStart(lobby)) {
    sendToClient(clientId, {
      event: "error",
      code: lobby.status === "open" ? "LOBBY_NOT_READY" : "LOBBY_NOT_JOINABLE",
      message: lobby.status === "open"
        ? "Lobby does not have enough players"
        : "Lobby is not in a startable state"
    });
    return;
  }

  startLobby(lobby, "owner_start");
}

// --- Echo Duel authoritative match helpers ---
const ECHO_INPUTS = ["W", "A", "S", "D"];
const ECHO_PHASES = {
  OWNER_CREATE_INITIAL: "owner_create_initial",
  OWNER_REPLAY: "owner_replay",
  OWNER_APPEND: "owner_append",
  SIGNAL_PLAYBACK: "signal_playback",
  CHALLENGER_COPY: "challenger_copy",
  MATCH_OVER: "match_over",
};
const ECHO_PLAYBACK_TIMING = {
  stepMs: 450,
  gapMs: 120,
  holdMs: 700,
};
const DEFAULT_ECHO_SETTINGS = {
  startingPatternLength: 4,
  patternAppendCount: 2,
  maxPatternLength: 10,
  timerSecondsPerInput: 1.25,
  minTimerSeconds: 6,
  maxTimerSeconds: 13,
  penaltyWord: "STATIC",
};

function sanitizeEchoDisplayName(value, fallback = "Player") {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return (trimmed || fallback).slice(0, 18);
}

function createEchoPlayersFromLobby(lobby) {
  const memberIds = lobby?.members ? [...lobby.members] : [];
  return memberIds.map((clientId, index) => {
    const profile = lobby?.memberProfiles instanceof Map ? lobby.memberProfiles.get(clientId) : null;
    return {
      id: clientId,
      clientId,
      name: sanitizeEchoDisplayName(profile?.displayName, `Player ${index + 1}`),
      letters: "",
      eliminated: false,
      lastResult: null,
    };
  });
}

function buildEchoSettings(lobby) {
  return {
    ...DEFAULT_ECHO_SETTINGS,
    penaltyWord: sanitizePenaltyWord(lobby?.settings?.penaltyWord || DEFAULT_ECHO_SETTINGS.penaltyWord),
    playerCount: lobbyPlayerCount(lobby),
  };
}

function cloneEchoTimer(timer) {
  return timer ? { ...timer } : null;
}

function cloneEchoPlayback(playback) {
  return playback
    ? { ...playback, sequence: [...(playback.sequence || [])] }
    : null;
}

function cloneEchoMatch(match) {
  return {
    ...match,
    settings: { ...match.settings },
    players: match.players.map((player) => ({ ...player })),
    activeSequence: [...match.activeSequence],
    ownerDraft: [...match.ownerDraft],
    copyProgress: Object.fromEntries(
      Object.entries(match.copyProgress || {}).map(([playerId, progress]) => [playerId, { ...progress }])
    ),
    roundResults: (match.roundResults || []).map((result) => ({ ...result })),
    timer: cloneEchoTimer(match.timer),
    playback: cloneEchoPlayback(match.playback),
    inputCursor: { ...(match.inputCursor || {}) },
  };
}

function echoActivePlayers(match) {
  return match.players.filter((player) => !player.eliminated);
}

function echoGetOwner(match) {
  return match.players[match.ownerIndex] || null;
}

function echoFindPlayerIndex(match, clientId) {
  return match.players.findIndex((player) => player.clientId === clientId || player.id === clientId);
}

function echoFirstActiveIndex(match) {
  return match.players.findIndex((player) => !player.eliminated);
}

function echoNextActiveIndex(match, fromIndex) {
  if (echoActivePlayers(match).length <= 0) return -1;
  for (let offset = 1; offset <= match.players.length; offset += 1) {
    const index = (fromIndex + offset) % match.players.length;
    if (!match.players[index]?.eliminated) return index;
  }
  return -1;
}

function echoTimerForLength(length, settings, now) {
  const raw = Number(length || 0) * Number(settings.timerSecondsPerInput || 1);
  const seconds = Math.max(Number(settings.minTimerSeconds || 0), Math.min(Number(settings.maxTimerSeconds || raw), raw));
  return {
    startedAt: now,
    durationMs: seconds * 1000,
    endsAt: now + (seconds * 1000),
  };
}

function echoAdvancePhase(match, phase, { newTurn = false } = {}) {
  match.phase = phase;
  match.phaseId = Number(match.phaseId || 0) + 1;
  if (newTurn) match.turnId = Number(match.turnId || 0) + 1;
  return match;
}

function echoAppendTargetLength(match) {
  const current = Number(match.activeSequence.length || 0);
  const appendCount = Math.max(1, Number(match.settings.patternAppendCount || 1));
  const maxLength = Math.max(current, Number(match.settings.maxPatternLength || current));
  return Math.min(maxLength, current + appendCount);
}

function echoRemainingAppendInputs(match) {
  return Math.max(0, Number(match.appendTargetLength || echoAppendTargetLength(match)) - Number(match.activeSequence.length || 0));
}

function echoClearPlayerResults(players) {
  return players.map((player) => ({ ...player, lastResult: null }));
}

function echoSetPlayerResult(players, playerId, result) {
  return players.map((player) => (
    player.id === playerId ? { ...player, lastResult: result } : player
  ));
}

function echoAwardLetter(match, playerIndex) {
  const next = cloneEchoMatch(match);
  const player = next.players[playerIndex];
  if (!player || player.eliminated) return next;

  const nextLetter = next.settings.penaltyWord[player.letters.length] || "";
  player.letters += nextLetter;
  player.lastResult = "fail";
  if (player.letters.length >= next.settings.penaltyWord.length) {
    player.eliminated = true;
    player.lastResult = "eliminated";
  }
  return next;
}

function echoBeginControl(match, ownerIndex, status = "") {
  const next = cloneEchoMatch(match);
  const safeOwner = ownerIndex >= 0 ? ownerIndex : echoFirstActiveIndex(next);
  echoAdvancePhase(next, ECHO_PHASES.OWNER_CREATE_INITIAL, { newTurn: true });
  next.ownerIndex = safeOwner >= 0 ? safeOwner : 0;
  next.activeSequence = [];
  next.ownerDraft = [];
  next.ownerReplayIndex = 0;
  next.appendTargetLength = 0;
  next.copyProgress = {};
  next.roundResults = [];
  next.timer = null;
  next.playback = null;
  next.players = echoClearPlayerResults(next.players);
  next.status = status || `${echoGetOwner(next)?.name || "Owner"} has control. Create a 4-input pattern.`;
  return next;
}

function echoBeginOwnerReplay(match, now) {
  const next = cloneEchoMatch(match);
  echoAdvancePhase(next, ECHO_PHASES.OWNER_REPLAY);
  next.ownerReplayIndex = 0;
  next.ownerDraft = [];
  next.appendTargetLength = 0;
  next.copyProgress = {};
  next.timer = echoTimerForLength(next.activeSequence.length, next.settings, now);
  next.playback = null;
  next.players = echoClearPlayerResults(next.players);
  next.status = `${echoGetOwner(next)?.name || "Owner"} must replay the ${next.activeSequence.length}-input sequence.`;
  return next;
}

function echoBeginChallengerCopy(match, now) {
  const next = cloneEchoMatch(match);
  echoAdvancePhase(next, ECHO_PHASES.CHALLENGER_COPY);
  next.copyProgress = {};
  next.roundResults = [];
  next.players = echoClearPlayerResults(next.players);
  for (const player of next.players) {
    if (!player.eliminated && player.id !== echoGetOwner(next)?.id) {
      next.copyProgress[player.id] = { index: 0, status: "copying", finishedAt: null };
    }
  }
  next.timer = echoTimerForLength(next.activeSequence.length, next.settings, now);
  next.playback = null;
  const count = Object.keys(next.copyProgress).length;
  next.status = count > 1
    ? `${count} challengers copy the ${next.activeSequence.length}-input pattern.`
    : `Challenger copies the ${next.activeSequence.length}-input pattern.`;
  return next;
}

function echoBeginSignalPlayback(match, now, status = "") {
  const next = cloneEchoMatch(match);
  const sequence = [...next.activeSequence].slice(0, Number(next.settings.maxPatternLength || 10));
  const stepMs = Number(ECHO_PLAYBACK_TIMING.stepMs || 450);
  const gapMs = Number(ECHO_PLAYBACK_TIMING.gapMs || 120);
  const holdMs = Number(ECHO_PLAYBACK_TIMING.holdMs || 700);
  const perInputMs = stepMs + gapMs;
  const totalMs = sequence.length * perInputMs + holdMs;

  echoAdvancePhase(next, ECHO_PHASES.SIGNAL_PLAYBACK);
  next.activeSequence = sequence;
  next.timer = null;
  next.copyProgress = {};
  next.roundResults = [];
  next.playback = {
    id: `${next.turnId}:${next.phaseId}:${sequence.join("")}`,
    sequence,
    startedAt: now,
    stepMs,
    gapMs,
    holdMs,
    perInputMs,
    totalMs,
    endsAt: now + totalMs,
  };
  next.status = status || `Memorize the ${sequence.length}-input signal.`;
  return next;
}

function echoFinishSignalPlayback(match, now) {
  const next = cloneEchoMatch(match);
  next.playback = null;
  return echoBeginChallengerCopy(next, now);
}

function echoFinishCopyPhase(match, now) {
  let next = cloneEchoMatch(match);
  const active = echoActivePlayers(next);
  if (active.length <= 1) {
    echoAdvancePhase(next, ECHO_PHASES.MATCH_OVER);
    next.winnerId = active[0]?.id || null;
    next.status = `${active[0]?.name || "No one"} wins.`;
    next.timer = null;
    return next;
  }

  const owner = echoGetOwner(next);
  const challengerIds = Object.keys(next.copyProgress || {});
  const successful = next.roundResults.filter((result) => result.result === "safe");
  const allChallengersSucceeded = challengerIds.length > 0 && successful.length === challengerIds.length;
  const reachedMax = next.activeSequence.length >= next.settings.maxPatternLength;

  if (!allChallengersSucceeded) {
    const ownerIndex = next.players.findIndex((player) => player.id === owner?.id);
    return echoBeginControl(
      next,
      ownerIndex >= 0 ? ownerIndex : next.ownerIndex,
      `${owner?.name || "Owner"} keeps control. Not everyone copied it, so the signal resets.`
    );
  }

  if (reachedMax) {
    const fastest = [...successful].sort((left, right) => Number(left.finishedAt || 0) - Number(right.finishedAt || 0))[0];
    const winnerIndex = next.players.findIndex((player) => player.id === fastest?.playerId);
    const safeIndex = winnerIndex >= 0 ? winnerIndex : echoNextActiveIndex(next, next.ownerIndex);
    return echoBeginControl(next, safeIndex, `${next.players[safeIndex]?.name || "Next player"} survived the 10-input chain and takes control.`);
  }

  next.status = `${owner?.name || "Owner"} keeps control. Everyone copied it, so the signal can grow.`;
  return echoBeginOwnerReplay(next, now);
}

function echoMarkChallengerResult(match, playerId, result, now) {
  let next = cloneEchoMatch(match);
  const progress = next.copyProgress[playerId];
  if (!progress || progress.status !== "copying") return next;

  progress.status = result;
  progress.finishedAt = now;
  next.roundResults.push({ playerId, result, finishedAt: progress.finishedAt });

  const playerIndex = next.players.findIndex((player) => player.id === playerId);
  if (result === "fail") {
    next = echoAwardLetter(next, playerIndex);
  } else {
    next.players = echoSetPlayerResult(next.players, playerId, "safe");
  }

  const active = echoActivePlayers(next);
  if (active.length <= 1) {
    echoAdvancePhase(next, ECHO_PHASES.MATCH_OVER);
    next.winnerId = active[0]?.id || null;
    next.status = `${active[0]?.name || "No one"} wins.`;
    next.timer = null;
    return next;
  }

  const unresolved = Object.values(next.copyProgress).some((item) => item.status === "copying");
  if (!unresolved) return echoFinishCopyPhase(next, now);

  const remaining = Object.values(next.copyProgress).filter((item) => item.status === "copying").length;
  next.status = `${remaining} challenger${remaining === 1 ? "" : "s"} still copying.`;
  return next;
}

function echoActorIndexForPhase(match, clientId) {
  if (clientId) return echoFindPlayerIndex(match, clientId);
  if (match.phase === ECHO_PHASES.CHALLENGER_COPY) {
    const nextCopyingId = Object.entries(match.copyProgress || {}).find(([, progress]) => progress.status === "copying")?.[0];
    return nextCopyingId ? echoFindPlayerIndex(match, nextCopyingId) : -1;
  }
  return match.ownerIndex;
}

function createEchoDuelMatchState(lobby, now = Date.now()) {
  const players = createEchoPlayersFromLobby(lobby);
  const count = players.length;
  const settings = buildEchoSettings(lobby);
  const seed = Number.isFinite(Number(lobby?.seed)) ? Math.abs(Number(lobby.seed)) : 0;
  const ownerIndex = count > 0 ? seed % count : 0;
  return {
    roomCode: lobby.roomCode,
    gameId: "echo-duel",
    phase: ECHO_PHASES.OWNER_CREATE_INITIAL,
    turnId: 1,
    phaseId: 1,
    settings,
    players,
    ownerIndex,
    activeSequence: [],
    ownerReplayIndex: 0,
    ownerDraft: [],
    appendTargetLength: 0,
    copyProgress: {},
    roundResults: [],
    winnerId: null,
    status: `${players[ownerIndex]?.name || "Owner"} starts control. Create a 4-input pattern.`,
    timer: null,
    playback: null,
    inputCursor: {},
    createdAt: now,
  };
}

function applyEchoInputToMatch(match, clientId, rawInput, meta = null, now = Date.now()) {
  if (now < Number(match.createdAt || 0)) return match;

  const input = String(rawInput || "").toUpperCase();
  if (!ECHO_INPUTS.includes(input)) return match;
  const inputId = Number(meta?.inputId);
  if (meta) {
    const phaseId = Number(meta.phaseId);
    const turnId = Number(meta.turnId);
    if (!Number.isFinite(phaseId) || !Number.isFinite(turnId)) return match;
    if (phaseId !== Number(match.phaseId || 0) || turnId !== Number(match.turnId || 0)) return match;
  }
  if (Number.isFinite(inputId) && inputId > 0 && inputId <= Number(match.inputCursor?.[clientId] || 0)) {
    return match;
  }

  let next = cloneEchoMatch(match);
  const actorIndex = echoActorIndexForPhase(next, clientId);
  const actor = next.players[actorIndex];
  const owner = echoGetOwner(next);
  if (!actor || actor.eliminated) return match;
  const rememberInput = () => {
    if (Number.isFinite(inputId) && inputId > 0) {
      next.inputCursor[actor.id] = inputId;
      next.inputCursor[actor.clientId] = inputId;
    }
  };

  if (next.phase === ECHO_PHASES.OWNER_CREATE_INITIAL) {
    if (actor.id !== owner?.id && actor.clientId !== owner?.clientId) return match;
    next.ownerDraft.push(input);
    rememberInput();
    if (next.ownerDraft.length >= next.settings.startingPatternLength) {
      next.activeSequence = [...next.ownerDraft];
      next.ownerDraft = [];
      next.status = `${owner?.name || "Owner"} set the starting pattern.`;
      return echoBeginSignalPlayback(next, now, `${owner?.name || "Owner"} set the starting signal. Memorize it.`);
    }
    next.status = `${owner?.name || "Owner"} is creating the starting pattern.`;
    return next;
  }

  if (next.phase === ECHO_PHASES.OWNER_REPLAY) {
    if (actor.id !== owner?.id && actor.clientId !== owner?.clientId) return match;
    const expected = next.activeSequence[next.ownerReplayIndex];
    rememberInput();
    if (input !== expected) {
      next.players = echoSetPlayerResult(next.players, owner?.id, "owner-fail");
      const passTo = echoNextActiveIndex(next, next.ownerIndex);
      return echoBeginControl(next, passTo, `${owner?.name || "Owner"} dropped their own pattern. Control passes.`);
    }

    next.ownerReplayIndex += 1;
    if (next.ownerReplayIndex >= next.activeSequence.length) {
      echoAdvancePhase(next, ECHO_PHASES.OWNER_APPEND);
      next.appendTargetLength = echoAppendTargetLength(next);
      const needed = echoRemainingAppendInputs(next);
      next.timer = echoTimerForLength(Math.max(1, needed), next.settings, now);
      next.status = `${owner?.name || "Owner"} replayed it. Add ${needed} new input${needed === 1 ? "" : "s"}.`;
    } else {
      next.status = `${owner?.name || "Owner"} replaying: ${next.ownerReplayIndex}/${next.activeSequence.length}.`;
    }
    return next;
  }

  if (next.phase === ECHO_PHASES.OWNER_APPEND) {
    if (actor.id !== owner?.id && actor.clientId !== owner?.clientId) return match;
    if (!next.appendTargetLength || next.appendTargetLength <= next.activeSequence.length) {
      next.appendTargetLength = echoAppendTargetLength(next);
    }
    const maxLength = Number(next.settings.maxPatternLength || next.appendTargetLength || next.activeSequence.length);
    next.appendTargetLength = Math.min(next.appendTargetLength, maxLength);
    if (next.activeSequence.length >= next.appendTargetLength || next.activeSequence.length >= maxLength) {
      next.status = `${owner?.name || "Owner"} hit the ${maxLength}-input cap. Memorize it.`;
      next.appendTargetLength = 0;
      return echoBeginSignalPlayback(next, now, `${owner?.name || "Owner"} hit the ${maxLength}-input cap. Memorize it.`);
    }

    next.activeSequence.push(input);
    rememberInput();
    if (next.activeSequence.length > maxLength) {
      next.activeSequence = next.activeSequence.slice(0, maxLength);
    }
    const remaining = echoRemainingAppendInputs(next);
    if (remaining > 0) {
      next.status = `${owner?.name || "Owner"} adding inputs: ${next.activeSequence.length}/${next.appendTargetLength}.`;
      return next;
    }
    next.status = `${owner?.name || "Owner"} extended the pattern to ${next.activeSequence.length}.`;
    next.appendTargetLength = 0;
    return echoBeginSignalPlayback(next, now, `${owner?.name || "Owner"} extended the signal to ${next.activeSequence.length}. Memorize it.`);
  }

  if (next.phase === ECHO_PHASES.CHALLENGER_COPY) {
    if (actor.id === owner?.id || actor.clientId === owner?.clientId) return match;
    const progress = next.copyProgress[actor.id];
    if (!progress || progress.status !== "copying") return match;

    const expected = next.activeSequence[progress.index];
    rememberInput();
    if (input !== expected) {
      return echoMarkChallengerResult(next, actor.id, "fail", now);
    }

    progress.index += 1;
    if (progress.index >= next.activeSequence.length) {
      return echoMarkChallengerResult(next, actor.id, "safe", now);
    }
    next.status = `${actor.name} copying: ${progress.index}/${next.activeSequence.length}.`;
    return next;
  }

  return next;
}

function advanceEchoMatchToTime(match, now = Date.now()) {
  if (match.phase === ECHO_PHASES.SIGNAL_PLAYBACK && match.playback) {
    if (now >= match.playback.endsAt) return echoFinishSignalPlayback(match, now);
    return match;
  }

  if (!match.timer) return match;
  if (now < match.timer.endsAt) return match;

  let next = cloneEchoMatch(match);
  if (next.phase === ECHO_PHASES.OWNER_REPLAY || next.phase === ECHO_PHASES.OWNER_APPEND) {
    const owner = echoGetOwner(next);
    const passTo = echoNextActiveIndex(next, next.ownerIndex);
    return echoBeginControl(next, passTo, `${owner?.name || "Owner"} ran out of time. Control passes.`);
  }

  if (next.phase === ECHO_PHASES.CHALLENGER_COPY) {
    const failingIds = Object.entries(next.copyProgress || {})
      .filter(([, progress]) => progress.status === "copying")
      .map(([playerId]) => playerId);

    for (const playerId of failingIds) {
      next = echoMarkChallengerResult(next, playerId, "fail", now);
      if (next.phase === ECHO_PHASES.MATCH_OVER) return next;
    }
  }

  return next;
}

function applyEchoDisconnectToMatch(match, clientId, now = Date.now()) {
  if (!match || match.phase === ECHO_PHASES.MATCH_OVER) return match;

  const leavingPlayer = match.players.find((player) => player.clientId === clientId || player.id === clientId);
  const activeBefore = echoActivePlayers(match).length;
  if (!leavingPlayer || leavingPlayer.eliminated) return match;

  if (activeBefore <= 2) {
    const closed = cloneEchoMatch(match);
    closed.phase = ECHO_PHASES.MATCH_OVER;
    closed.winnerId = null;
    closed.timer = null;
    closed.playback = null;
    closed.status = `${leavingPlayer.name} disconnected. The match was closed.`;
    return closed;
  }

  let next = cloneEchoMatch(match);
  const leavingIndex = next.players.findIndex((player) => player.clientId === clientId || player.id === clientId);
  if (leavingIndex < 0) return match;

  next.players[leavingIndex] = {
    ...next.players[leavingIndex],
    eliminated: true,
    lastResult: "disconnected",
  };
  delete next.copyProgress[next.players[leavingIndex].id];

  const remaining = next.players.filter((player) => !player.eliminated);
  if (remaining.length <= 1) {
    next.phase = ECHO_PHASES.MATCH_OVER;
    next.winnerId = remaining[0]?.id || null;
    next.timer = null;
    next.playback = null;
    next.status = `${remaining[0]?.name || "No one"} wins after a disconnect.`;
    return next;
  }

  const leavingWasOwner = leavingIndex === next.ownerIndex;
  if (leavingWasOwner) {
    const nextOwnerIndex = echoNextActiveIndex(next, leavingIndex);
    return echoBeginControl(
      next,
      nextOwnerIndex >= 0 ? nextOwnerIndex : 0,
      `${leavingPlayer.name} disconnected. ${next.players[nextOwnerIndex]?.name || "Next player"} takes control.`
    );
  }

  if (next.phase === ECHO_PHASES.CHALLENGER_COPY) {
    const unresolved = Object.values(next.copyProgress || {}).some((progress) => progress.status === "copying");
    if (!unresolved) {
      next = echoFinishCopyPhase(next, now);
      next.status = `${leavingPlayer.name} disconnected and was removed from the match.`;
      return next;
    }
  }

  next.status = `${leavingPlayer.name} disconnected and was removed from the match.`;
  return next;
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
      joinLobby(clientId, data.roomCode, data.identity);
      return;
    }

    if (type === "find_lobby") {
      const gameId = sanitizeLobbyGameId(data.gameId);
      const existing = findOpenLobby(gameId);
      if (existing) {
        joinLobby(clientId, existing.roomCode, data.identity);
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

      const lobby = lobbies.get(roomCode);
      const messageType = String(data.messageType || "");
      const value = String(data.value ?? "");

      if (isEchoDuelLobby(lobby)) {
        if (messageType === "profile") {
          let profile = null;
          try {
            profile = JSON.parse(value);
          } catch {
            profile = null;
          }
          rememberLobbyIdentity(lobby, clientId, profile);
        }

        if (messageType === "input") {
          handleEchoLobbyInput(lobby, clientId, value);
          return;
        }

        if (messageType === "state_sync") return;
      }

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
  isLobbyJoinable,
  canLobbyStart,
  canLobbyOwnerUpdateSettings,
  createEchoDuelMatchState,
  applyEchoInputToMatch,
  advanceEchoMatchToTime,
  applyEchoDisconnectToMatch,
  serializeEchoMatchState,
  buildLobbyStartedPayload,
  cancelEchoLobbyStart,
  isEchoLobbyMatchPendingStart,
  shouldSendGenericLobbyUpdateAfterLeave,
};
