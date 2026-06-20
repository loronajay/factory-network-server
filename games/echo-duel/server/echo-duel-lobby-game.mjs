// Echo Duel lobby-game adapter. Implements the lobby game-module interface
// (see src/lobby.mjs) so the generic lobby lifecycle never has to know anything
// Echo-specific. All side effects (timers, broadcasts, lobby mutation) live here;
// the pure rules live in echo-duel-match-engine.mjs.
import { lobbies } from "../../../src/state.mjs";
import { broadcastToLobby, sendLobbyUpdated } from "../../../src/lobby-bus.mjs";
import {
  ECHO_DUEL_GAME_ID,
  ECHO_PHASES,
  createEchoDuelMatchState,
  applyEchoInputToMatch,
  advanceEchoMatchToTime,
  applyEchoDisconnectToMatch,
  serializeEchoMatchState,
  getEchoAuthorityMessageType,
  nextEchoMatchDeadline,
} from "./echo-duel-match-engine.mjs";

function clearEchoMatchTimer(lobby) {
  if (!lobby) return;
  if (lobby.echoMatchTimer) clearTimeout(lobby.echoMatchTimer);
  lobby.echoMatchTimer = null;
}

function syncLobbyStatusFromEchoMatch(lobby) {
  if (!lobby?.echoMatch) return;
  lobby.status = lobby.echoMatch.phase === ECHO_PHASES.MATCH_OVER ? "ended" : "started";
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

function isEchoLobbyMatchPendingStart(lobby, now = Date.now()) {
  return !!lobby?.echoMatch
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

export const echoDuelLobbyGame = {
  gameId: ECHO_DUEL_GAME_ID,

  initMatch(lobby, startAt) {
    lobby.echoSyncSeq = 0;
    lobby.echoMatch = createEchoDuelMatchState(lobby, startAt);
    syncLobbyStatusFromEchoMatch(lobby);
  },

  afterStart(lobby) {
    scheduleEchoMatchTimer(lobby);
  },

  startedPayloadExtras(lobby, serverNow) {
    if (!lobby.echoMatch) return {};
    return {
      authorityMode: "server",
      matchState: serializeEchoMatchState(lobby.echoMatch, lobby, serverNow),
    };
  },

  // Returns { handled, error? }. Profile updates are left unhandled so the
  // generic lobby still remembers identity and rebroadcasts the message.
  handleMessage(lobby, clientId, messageType, value) {
    if (messageType === "input") {
      handleEchoLobbyInput(lobby, clientId, value);
      return { handled: true };
    }
    if (messageType === "state_sync") return { handled: true };
    return { handled: false };
  },

  isMatchPendingStart(lobby, now) {
    return isEchoLobbyMatchPendingStart(lobby, now);
  },

  cancelPendingStart(lobby) {
    cancelEchoLobbyStart(lobby);
  },

  hasActiveMatch(lobby) {
    return !!lobby?.echoMatch;
  },

  // Applies a disconnect to the live match, mutating lobby state. Returns true
  // when the match changed (so the caller can broadcast).
  applyDisconnect(lobby, clientId, now) {
    if (!lobby.echoMatch) return false;
    const nextMatch = applyEchoDisconnectToMatch(lobby.echoMatch, clientId, now);
    if (nextMatch === lobby.echoMatch) return false;
    lobby.echoMatch = nextMatch;
    syncLobbyStatusFromEchoMatch(lobby);
    return true;
  },

  broadcastAfterLeave(lobby) {
    broadcastEchoMatchState(lobby);
    if (lobby.status === "ended") sendLobbyUpdated(lobby);
    scheduleEchoMatchTimer(lobby);
  },

  clearTimers(lobby) {
    clearEchoMatchTimer(lobby);
  },
};
