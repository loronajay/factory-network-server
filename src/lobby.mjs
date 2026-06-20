// Generic v2 lobby lifecycle (2-6 player games). This module is intentionally
// game-agnostic: anything game-specific (authoritative match state, timers,
// snapshots) is delegated to a lobby game-module looked up via the registry.
//
// Lobby game-module interface (all methods optional except gameId):
//   gameId                                  the gameId this module handles
//   initMatch(lobby, startAt)               create authoritative match state on the lobby
//   afterStart(lobby)                       schedule timers / send the first match message
//   startedPayloadExtras(lobby, serverNow)  -> {} or { authorityMode, matchState }
//   handleMessage(lobby, clientId, type, value) -> { handled, error? }
//   isMatchPendingStart(lobby, now)         -> bool (start scheduled but not kicked off)
//   cancelPendingStart(lobby)               revert a pending start back to an open lobby
//   applyDisconnect(lobby, clientId, now)   -> bool changed (mutates match + status)
//   broadcastAfterLeave(lobby)              broadcast the post-disconnect match state
//   hasActiveMatch(lobby)                   -> bool (suppresses the generic post-leave update)
//   clearTimers(lobby)                      cancel any game timers on the lobby
import {
  lobbies,
  clientLobbies,
  DEFAULT_LOBBY_COUNTDOWN_MS,
  LOBBY_START_DELAY_MS,
} from "./state.mjs";
import { sendToClient, uniqueRoomCode } from "./transport.mjs";
import {
  clampInt,
  sanitizeLobbyGameId,
  sanitizeLobbySettings,
  sanitizeLobbyIdentity,
  sanitizeLobbyLimits,
  lobbyPlayerCount,
} from "./util.mjs";
import { leaveQueue, makeMatchSeed } from "./matchmaking.mjs";
import { leaveRoom } from "./rooms.mjs";
import { lobbyGame } from "../games/registry.mjs";
import {
  getLobbyMemberIds,
  broadcastToLobby,
  buildLobbyPayload,
  sendLobbyUpdated,
} from "./lobby-bus.mjs";

export { sanitizeLobbyLimits, lobbyPlayerCount };
// Re-exported from the leaf bus so existing importers of these from "./lobby.mjs"
// keep working.
export { getLobbyMemberIds, broadcastToLobby, buildLobbyPayload, sendLobbyUpdated };

export function isLobbyJoinable(lobby) {
  if (!lobby) return false;
  return lobby.status === "open" && lobbyPlayerCount(lobby) < lobby.maxPlayers;
}

export function canLobbyStart(lobby) {
  if (!lobby) return false;
  return lobby.status === "open" && lobbyPlayerCount(lobby) >= lobby.minPlayers;
}

export function canLobbyOwnerUpdateSettings(lobby) {
  if (!lobby) return false;
  return lobby.status === "open";
}

export function rememberLobbyIdentity(lobby, clientId, identity) {
  if (!lobby || !clientId) return;
  const sanitized = sanitizeLobbyIdentity(identity);
  if (!sanitized) return;
  if (!(lobby.memberProfiles instanceof Map)) lobby.memberProfiles = new Map();
  lobby.memberProfiles.set(clientId, sanitized);
}

function clearLobbyCountdown(lobby) {
  if (!lobby) return;
  if (lobby.countdownTimer) clearTimeout(lobby.countdownTimer);
  lobby.countdownTimer = null;
  lobby.startAt = null;
  if (lobby.status === "countdown") lobby.status = "open";
}

export function buildLobbyStartedPayload(lobby, serverNow = Date.now(), reason = "manual") {
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

  const game = lobbyGame(lobby.gameId);
  return { ...payload, ...(game?.startedPayloadExtras?.(lobby, serverNow) || {}) };
}

export function startLobby(lobby, reason = "manual") {
  if (!canLobbyStart(lobby)) return false;

  const game = lobbyGame(lobby.gameId);
  clearLobbyCountdown(lobby);
  game?.clearTimers?.(lobby);
  lobby.status = "started";
  lobby.seed = makeMatchSeed();

  const serverNow = Date.now();
  const startAt = serverNow + LOBBY_START_DELAY_MS;
  lobby.startAt = startAt;

  game?.initMatch?.(lobby, startAt);

  broadcastToLobby(lobby.roomCode, buildLobbyStartedPayload(lobby, serverNow, reason));
  game?.afterStart?.(lobby);
  return true;
}

function maybeStartLobbyCountdown(lobby) {
  if (!lobby) return;
  clearLobbyCountdown(lobby);
  sendLobbyUpdated(lobby);
}

export function leaveLobby(clientId, reason = "left") {
  const roomCode = clientLobbies.get(clientId);
  if (!roomCode) return;

  const lobby = lobbies.get(roomCode);
  if (!lobby) {
    clientLobbies.delete(clientId);
    return;
  }

  const game = lobbyGame(lobby.gameId);

  lobby.members.delete(clientId);
  clientLobbies.delete(clientId);
  if (lobby.memberProfiles instanceof Map) lobby.memberProfiles.delete(clientId);

  sendToClient(clientId, {
    event: "lobby_left",
    roomCode,
  });

  if (lobby.members.size === 0) {
    clearLobbyCountdown(lobby);
    game?.clearTimers?.(lobby);
    lobbies.delete(roomCode);
    return;
  }

  if (lobby.ownerId === clientId) {
    lobby.ownerId = [...lobby.members][0];
  }

  const now = Date.now();
  if (game?.isMatchPendingStart?.(lobby, now)) {
    game.cancelPendingStart?.(lobby);
  }

  const matchChanged = game?.applyDisconnect ? game.applyDisconnect(lobby, clientId, now) : false;

  broadcastToLobby(roomCode, {
    event: "lobby_player_left",
    clientId,
    roomCode,
    playerCount: lobby.members.size,
    ownerId: lobby.ownerId,
    reason,
  });

  if (matchChanged) {
    game.broadcastAfterLeave?.(lobby);
  }

  // Once a game owns an active match, the post-leave generic refresh is the
  // game's responsibility (handled above); otherwise emit the generic update.
  if (!game?.hasActiveMatch?.(lobby)) {
    maybeStartLobbyCountdown(lobby);
    sendLobbyUpdated(lobby);
  }
}

export function createLobby(clientId, data = {}, { isPrivate = false } = {}) {
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

export function joinLobby(clientId, roomCode, identity = null) {
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

export function doesLobbyMatchSearch(lobby, gameId, limits = null) {
  const targetGameId = sanitizeLobbyGameId(gameId);
  if (lobby?.gameId !== targetGameId) return false;
  if (lobby?.isPrivate) return false;
  if (!isLobbyJoinable(lobby)) return false;
  if (limits) {
    const searchLimits = sanitizeLobbyLimits(limits.minPlayers, limits.maxPlayers);
    if (lobby.minPlayers !== searchLimits.minPlayers) return false;
    if (lobby.maxPlayers !== searchLimits.maxPlayers) return false;
  }
  return true;
}

export function findOpenLobby(gameId, limits = null) {
  let best = null;

  for (const lobby of lobbies.values()) {
    if (!doesLobbyMatchSearch(lobby, gameId, limits)) continue;
    if (!best || lobby.createdAt < best.createdAt) best = lobby;
  }

  return best;
}

export function updateLobbySettings(clientId, data = {}) {
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

export function requestStartLobby(clientId) {
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
