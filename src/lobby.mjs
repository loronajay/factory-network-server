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
  clientDisplayLobbies,
  clientSessionTokens,
  suspendedLobbySessions,
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

function lobbyLimitsForGame(game, minPlayers, maxPlayers) {
  const required = game?.lobbyLimits;
  if (!required) return sanitizeLobbyLimits(minPlayers, maxPlayers);
  const requested = sanitizeLobbyLimits(
    Number.isFinite(Number(minPlayers)) ? minPlayers : required.minPlayers,
    Number.isFinite(Number(maxPlayers)) ? maxPlayers : required.maxPlayers,
  );
  const max = Math.max(Number(required.minPlayers) || 2, Math.min(requested.maxPlayers, Number(required.maxPlayers) || requested.maxPlayers));
  return {
    minPlayers: Math.max(Number(required.minPlayers) || 2, Math.min(requested.minPlayers, max)),
    maxPlayers: max,
  };
}

export function isLobbyJoinable(lobby) {
  if (!lobby) return false;
  return lobby.status === "open" && lobbyPlayerCount(lobby) < lobby.maxPlayers;
}

export function canLobbyStart(lobby) {
  if (!lobby) return false;
  if (lobby.status !== "open" || lobbyPlayerCount(lobby) < lobby.minPlayers) return false;
  return lobbyGame(lobby.gameId)?.canStart?.(lobby) ?? true;
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

function clearSuspendedLobbySession(clientId) {
  const suspended = suspendedLobbySessions.get(clientId);
  if (suspended?.timer) clearTimeout(suspended.timer);
  suspendedLobbySessions.delete(clientId);
}

function reconnectGraceMs(lobby) {
  const value = Number(lobbyGame(lobby?.gameId)?.reconnectGracePeriodMs);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function suspendLobbyClient(clientId, reason = "disconnect", now = Date.now()) {
  const roomCode = clientLobbies.get(clientId);
  const lobby = lobbies.get(roomCode);
  if (!lobby || lobby.status !== "started" || !reconnectGraceMs(lobby) || suspendedLobbySessions.has(clientId)) return false;

  const game = lobbyGame(lobby.gameId);
  const matchChanged = game?.applyDisconnect?.(lobby, clientId, now) || false;
  const expiresAt = now + reconnectGraceMs(lobby);
  const timer = setTimeout(() => expireSuspendedLobbyClient(clientId), reconnectGraceMs(lobby));
  if (typeof timer.unref === "function") timer.unref();
  suspendedLobbySessions.set(clientId, { roomCode, expiresAt, timer });

  broadcastToLobby(roomCode, {
    event: "lobby_player_disconnected",
    clientId,
    roomCode,
    reconnectExpiresAt: expiresAt,
    reason,
  }, clientId);
  if (matchChanged) game?.broadcastAfterLeave?.(lobby);
  return true;
}

export function expireSuspendedLobbyClient(clientId) {
  const suspended = suspendedLobbySessions.get(clientId);
  if (!suspended) return false;
  clearSuspendedLobbySession(clientId);
  leaveLobby(clientId, "reconnect_expired");
  clientSessionTokens.delete(clientId);
  return true;
}

export function resumeLobbyClient(currentClientId, previousClientId, sessionToken, now = Date.now()) {
  const originalId = String(previousClientId || "");
  const suspended = suspendedLobbySessions.get(originalId);
  if (!suspended || suspended.expiresAt <= now || clientSessionTokens.get(originalId) !== sessionToken) return null;
  const lobby = lobbies.get(suspended.roomCode);
  if (!lobby || clientLobbies.get(originalId) !== lobby.roomCode) return null;

  clearSuspendedLobbySession(originalId);
  const game = lobbyGame(lobby.gameId);
  const matchChanged = game?.applyReconnect?.(lobby, originalId, now) || false;
  broadcastToLobby(lobby.roomCode, {
    event: "lobby_player_reconnected",
    clientId: originalId,
    roomCode: lobby.roomCode,
  }, originalId);
  return lobby;
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

  clearSuspendedLobbySession(clientId);

  lobby.members.delete(clientId);
  clientLobbies.delete(clientId);
  if (lobby.memberProfiles instanceof Map) lobby.memberProfiles.delete(clientId);
  clientSessionTokens.delete(clientId);

  sendToClient(clientId, {
    event: "lobby_left",
    roomCode,
  });

  if (lobby.members.size === 0 && !lobby.displayClientId) {
    clearLobbyCountdown(lobby);
    game?.clearTimers?.(lobby);
    lobbies.delete(roomCode);
    return;
  }

  if (lobby.members.size === 0) {
    maybeStartLobbyCountdown(lobby);
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

export function leaveDisplayLobby(clientId, reason = "left") {
  const roomCode = clientDisplayLobbies.get(clientId);
  if (!roomCode) return;
  const lobby = lobbies.get(roomCode);
  clientDisplayLobbies.delete(clientId);
  if (!lobby || lobby.displayClientId !== clientId) return;

  const game = lobbyGame(lobby.gameId);
  clearLobbyCountdown(lobby);
  game?.clearTimers?.(lobby);
  for (const memberId of lobby.members) {
    clientLobbies.delete(memberId);
    sendToClient(memberId, { event: "lobby_closed", roomCode, reason: "display_left" });
  }
  lobbies.delete(roomCode);
}

export function createLobby(clientId, data = {}, { isPrivate = false, displayOnly = false } = {}) {
  leaveQueue(clientId);
  leaveRoom(clientId, "create_lobby");
  leaveLobby(clientId, "create_new_lobby");
  leaveDisplayLobby(clientId, "create_new_lobby");

  const roomCode = uniqueRoomCode();
  const gameId = sanitizeLobbyGameId(data.gameId);
  const limits = lobbyLimitsForGame(lobbyGame(gameId), data.minPlayers, data.maxPlayers);
  const lobby = {
    roomCode,
    gameId,
    ownerId: clientId,
    members: displayOnly ? new Set() : new Set([clientId]),
    memberProfiles: new Map(),
    displayClientId: displayOnly ? clientId : null,
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
  if (displayOnly) clientDisplayLobbies.set(clientId, roomCode);
  else rememberLobbyIdentity(lobby, clientId, data.identity);

  lobbies.set(roomCode, lobby);
  if (!displayOnly) clientLobbies.set(clientId, roomCode);

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
  leaveDisplayLobby(clientId, "join_lobby");

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

function sameLobbySettings(a = {}, b = {}) {
  const left = sanitizeLobbySettings(a);
  const right = sanitizeLobbySettings(b);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

export function doesLobbyMatchSearch(lobby, gameId, limits = null, settings = null) {
  const targetGameId = sanitizeLobbyGameId(gameId);
  if (lobby?.gameId !== targetGameId) return false;
  if (lobby?.isPrivate) return false;
  if (!isLobbyJoinable(lobby)) return false;
  if (limits) {
    const searchLimits = sanitizeLobbyLimits(limits.minPlayers, limits.maxPlayers);
    if (lobby.minPlayers !== searchLimits.minPlayers) return false;
    if (lobby.maxPlayers !== searchLimits.maxPlayers) return false;
  }
  if (settings && !sameLobbySettings(lobby.settings, settings)) return false;
  return true;
}

export function findOpenLobby(gameId, limits = null, settings = null) {
  let best = null;

  for (const lobby of lobbies.values()) {
    if (!doesLobbyMatchSearch(lobby, gameId, limits, settings)) continue;
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

  const limits = lobbyLimitsForGame(lobbyGame(lobby.gameId),
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
  const roomCode = clientLobbies.get(clientId) || clientDisplayLobbies.get(clientId);
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
