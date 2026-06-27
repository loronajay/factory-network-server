// Network adapter for Questionable Decisions. The match engine stays pure; this
// module owns transport, phase timers, and the lobby-game integration contract.
// The shared display and every phone controller receive the same public state;
// each controller also gets a private state with its own role flags.
import { broadcastToLobby } from "../../../src/lobby-bus.mjs";
import { sendToClient } from "../../../src/transport.mjs";
import {
  QD_GAME_ID,
  QD_PHASES,
  QD_CONFIG,
  createQDMatchState,
  submitThemeVote,
  allThemeVotesIn,
  resolveThemeVote,
  selectTile,
  autoSelectTile,
  submitAnswer,
  resolveAnswer,
  advanceAfterReveal,
  beginPenalty,
  submitPenaltyInput,
  resolvePenalty,
  advanceAfterPenalty,
  advanceTurn,
  applyQDConnection,
  serializeQDPublicState,
  serializeQDPrivateState,
} from "./qd-match-engine.mjs";

function clearPhaseTimer(lobby) {
  if (lobby?.qdTimer) clearTimeout(lobby.qdTimer);
  if (lobby) lobby.qdTimer = null;
}

function sendState(lobby) {
  if (!lobby?.qdMatch) return;
  const match = lobby.qdMatch;
  broadcastToLobby(lobby.roomCode, {
    event: "message",
    scope: "lobby",
    messageType: "qd_public_state",
    value: JSON.stringify(serializeQDPublicState(match)),
    senderId: "server",
    roomCode: lobby.roomCode,
  });
  for (const memberId of lobby.members) {
    const privateState = serializeQDPrivateState(match, memberId);
    if (!privateState) continue;
    sendToClient(memberId, {
      event: "message",
      scope: "lobby",
      messageType: "qd_private_state",
      value: JSON.stringify(privateState),
      senderId: "server",
      roomCode: lobby.roomCode,
    });
  }
}

// Each timed phase resolves to the next via the pure engine. Input-driven phases
// (board/question waiting on the active player) advance on input in handleMessage,
// but still carry a timeout here so play never stalls on an idle/dropped player.
function advancePhase(match, now) {
  switch (match.phase) {
    case QD_PHASES.THEME_VOTE: return resolveThemeVote(match, now);
    case QD_PHASES.BOARD: return autoSelectTile(match, now);
    case QD_PHASES.QUESTION: return resolveAnswer(match, now);
    case QD_PHASES.ANSWER_REVEAL: return advanceAfterReveal(match, now);
    case QD_PHASES.PENALTY_INTRO: return beginPenalty(match, now);
    case QD_PHASES.PENALTY_ACTIVE: return resolvePenalty(match, now);
    case QD_PHASES.PENALTY_RESULTS: return advanceAfterPenalty(match, now);
    case QD_PHASES.SCOREBOARD: return advanceTurn(match, now);
    default: return match;
  }
}

function transition(lobby, now = Date.now()) {
  if (!lobby?.qdMatch) return;
  lobby.qdMatch = advancePhase(lobby.qdMatch, now);
  sendState(lobby);
  schedulePhase(lobby);
}

function schedulePhase(lobby) {
  clearPhaseTimer(lobby);
  const delay = QD_CONFIG.durations[lobby?.qdMatch?.phase];
  if (!delay) return; // MATCH_END (and any non-timed phase) has no timer.
  lobby.qdTimer = setTimeout(() => transition(lobby), delay);
  if (typeof lobby.qdTimer.unref === "function") lobby.qdTimer.unref();
}

function parse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

// Apply an engine result: always re-publish; only restart the phase timer when the
// phase actually changed (so a vote or a penalty tap doesn't reset its own clock).
function applyResult(lobby, previousPhase) {
  const phaseChanged = lobby.qdMatch.phase !== previousPhase;
  sendState(lobby);
  if (phaseChanged) schedulePhase(lobby);
}

export const questionableDecisionsLobbyGame = {
  gameId: QD_GAME_ID,
  lobbyLimits: { minPlayers: QD_CONFIG.minimumPlayers, maxPlayers: QD_CONFIG.maximumPlayers },
  reconnectGracePeriodMs: 30_000,

  canStart(lobby) {
    const count = lobby?.members?.size || 0;
    return count >= QD_CONFIG.minimumPlayers && count <= QD_CONFIG.maximumPlayers;
  },

  initMatch(lobby, startAt) {
    lobby.qdMatch = createQDMatchState(lobby, startAt);
  },

  afterStart(lobby) {
    sendState(lobby);
    schedulePhase(lobby);
  },

  startedPayloadExtras(lobby) {
    return { authorityMode: "server", matchState: serializeQDPublicState(lobby.qdMatch) };
  },

  handleMessage(lobby, clientId, messageType, value) {
    if (!lobby.qdMatch) return { handled: false };
    const payload = parse(value);
    const previousPhase = lobby.qdMatch.phase;
    const now = Date.now();

    if (messageType === "qd_theme_vote") {
      if (!payload?.themeId) return { handled: true, error: { code: "BAD_PAYLOAD", message: "Theme vote requires a themeId." } };
      lobby.qdMatch = submitThemeVote(lobby.qdMatch, clientId, payload.themeId, now);
      if (allThemeVotesIn(lobby.qdMatch)) lobby.qdMatch = resolveThemeVote(lobby.qdMatch, now);
      applyResult(lobby, previousPhase);
      return { handled: true };
    }
    if (messageType === "qd_select_tile") {
      if (!Number.isInteger(payload?.categoryIndex) || !Number.isInteger(payload?.tileIndex)) {
        return { handled: true, error: { code: "BAD_PAYLOAD", message: "Tile select requires categoryIndex and tileIndex." } };
      }
      lobby.qdMatch = selectTile(lobby.qdMatch, clientId, payload.categoryIndex, payload.tileIndex, now);
      applyResult(lobby, previousPhase);
      return { handled: true };
    }
    if (messageType === "qd_answer") {
      lobby.qdMatch = submitAnswer(lobby.qdMatch, clientId, payload?.answer, now);
      applyResult(lobby, previousPhase);
      return { handled: true };
    }
    if (messageType === "qd_penalty_input") {
      lobby.qdMatch = submitPenaltyInput(lobby.qdMatch, clientId, payload?.input, now);
      applyResult(lobby, previousPhase);
      return { handled: true };
    }
    if (messageType === "qd_reaction") {
      // Spectator reactions are transient social flavor — relay, never scored.
      if (payload?.reaction) {
        broadcastToLobby(lobby.roomCode, {
          event: "message",
          scope: "lobby",
          messageType: "qd_reaction",
          value: JSON.stringify({ reaction: String(payload.reaction).slice(0, 24), playerId: clientId }),
          senderId: clientId,
          roomCode: lobby.roomCode,
        });
      }
      return { handled: true };
    }
    return { handled: false };
  },

  isMatchPendingStart() { return false; },
  cancelPendingStart() {},
  hasActiveMatch(lobby) { return !!lobby?.qdMatch; },

  applyDisconnect(lobby, clientId, now) {
    if (!lobby?.qdMatch) return false;
    lobby.qdMatch = applyQDConnection(lobby.qdMatch, clientId, false, now);
    return true;
  },

  applyReconnect(lobby, clientId, now) {
    if (!lobby?.qdMatch) return false;
    lobby.qdMatch = applyQDConnection(lobby.qdMatch, clientId, true, now);
    return true;
  },

  broadcastAfterLeave(lobby) { sendState(lobby); },
  broadcastAfterReconnect(lobby) { sendState(lobby); },
  clearTimers(lobby) { clearPhaseTimer(lobby); },
};
