// Network adapter for Pot of Greed. The match engine remains pure; this module
// owns transport, phase timers, and the lobby-game integration contract.
import { broadcastToLobby } from "../../../src/lobby-bus.mjs";
import { sendToClient } from "../../../src/transport.mjs";
import {
  POT_OF_GREED_GAME_ID,
  POT_OF_GREED_PHASES,
  POT_OF_GREED_CONFIG,
  createPotOfGreedMatchState,
  submitPotOfGreedVaultAction,
  resolvePotOfGreedVaultActions,
  beginPotOfGreedVote,
  submitPotOfGreedVote,
  resolvePotOfGreedVote,
  advancePotOfGreedCycle,
  applyPotOfGreedConnection,
  serializePotOfGreedPublicState,
  serializePotOfGreedPrivateState,
} from "./pot-of-greed-match-engine.mjs";

function clearPhaseTimer(lobby) {
  if (lobby?.potOfGreedTimer) clearTimeout(lobby.potOfGreedTimer);
  if (lobby) lobby.potOfGreedTimer = null;
}

function sendState(lobby) {
  if (!lobby?.potOfGreedMatch) return;
  const match = lobby.potOfGreedMatch;
  const publicState = serializePotOfGreedPublicState(match);
  broadcastToLobby(lobby.roomCode, {
    event: "message",
    scope: "lobby",
    messageType: "pot_of_greed_public_state",
    value: JSON.stringify(publicState),
    senderId: "server",
    roomCode: lobby.roomCode,
  });
  for (const memberId of lobby.members) {
    const privateState = serializePotOfGreedPrivateState(match, memberId);
    if (!privateState) continue;
    sendToClient(memberId, {
      event: "message",
      scope: "lobby",
      messageType: "pot_of_greed_private_state",
      value: JSON.stringify(privateState),
      senderId: "server",
      roomCode: lobby.roomCode,
    });
  }
}

function transition(lobby, now = Date.now()) {
  const match = lobby?.potOfGreedMatch;
  if (!match) return;
  if (match.phase === POT_OF_GREED_PHASES.HIDDEN_VAULT_ACTION || match.phase === POT_OF_GREED_PHASES.SHOW_VAULT_ACTION) {
    lobby.potOfGreedMatch = resolvePotOfGreedVaultActions(match, now);
  } else if (match.phase === POT_OF_GREED_PHASES.HIDDEN_DISCUSSION || match.phase === POT_OF_GREED_PHASES.SHOW_DISCUSSION) {
    lobby.potOfGreedMatch = beginPotOfGreedVote(match, now);
  } else if (match.phase === POT_OF_GREED_PHASES.HIDDEN_VOTE || match.phase === POT_OF_GREED_PHASES.SHOW_VOTE || match.phase === POT_OF_GREED_PHASES.HIDDEN_RUNOFF_VOTE || match.phase === POT_OF_GREED_PHASES.SHOW_RUNOFF_VOTE) {
    lobby.potOfGreedMatch = resolvePotOfGreedVote(match, now);
  } else if (match.phase === POT_OF_GREED_PHASES.HIDDEN_VOTE_RESULT || match.phase === POT_OF_GREED_PHASES.SHOW_VOTE_RESULT) {
    lobby.potOfGreedMatch = advancePotOfGreedCycle(match, now);
  }
  sendState(lobby);
  schedulePhase(lobby);
}

function phaseDuration(match) {
  if (!match) return 0;
  if (match.phase === POT_OF_GREED_PHASES.HIDDEN_VAULT_ACTION || match.phase === POT_OF_GREED_PHASES.SHOW_VAULT_ACTION) return POT_OF_GREED_CONFIG.vaultActionDuration;
  if (match.phase === POT_OF_GREED_PHASES.HIDDEN_DISCUSSION || match.phase === POT_OF_GREED_PHASES.SHOW_DISCUSSION) return POT_OF_GREED_CONFIG.discussionDuration;
  if (match.phase === POT_OF_GREED_PHASES.HIDDEN_VOTE || match.phase === POT_OF_GREED_PHASES.SHOW_VOTE || match.phase === POT_OF_GREED_PHASES.HIDDEN_RUNOFF_VOTE || match.phase === POT_OF_GREED_PHASES.SHOW_RUNOFF_VOTE) return POT_OF_GREED_CONFIG.voteDuration;
  if (match.phase === POT_OF_GREED_PHASES.HIDDEN_VOTE_RESULT || match.phase === POT_OF_GREED_PHASES.SHOW_VOTE_RESULT) return POT_OF_GREED_CONFIG.resultDuration;
  return 0;
}

function schedulePhase(lobby) {
  clearPhaseTimer(lobby);
  const delay = phaseDuration(lobby?.potOfGreedMatch);
  if (!delay) return;
  lobby.potOfGreedTimer = setTimeout(() => transition(lobby), delay);
  if (typeof lobby.potOfGreedTimer.unref === "function") lobby.potOfGreedTimer.unref();
}

function parse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

export const potOfGreedLobbyGame = {
  gameId: POT_OF_GREED_GAME_ID,
  lobbyLimits: { minPlayers: POT_OF_GREED_CONFIG.minimumPlayers, maxPlayers: POT_OF_GREED_CONFIG.maximumPlayers },
  reconnectGracePeriodMs: 30_000,

  canStart(lobby) {
    const count = lobby?.members?.size || 0;
    return count >= POT_OF_GREED_CONFIG.minimumPlayers && count <= POT_OF_GREED_CONFIG.maximumPlayers;
  },

  initMatch(lobby, startAt) {
    lobby.potOfGreedMatch = createPotOfGreedMatchState(lobby, startAt);
  },

  afterStart(lobby) {
    sendState(lobby);
    schedulePhase(lobby);
  },

  startedPayloadExtras(lobby) {
    return { authorityMode: "server", matchState: serializePotOfGreedPublicState(lobby.potOfGreedMatch) };
  },

  handleMessage(lobby, clientId, messageType, value) {
    if (!lobby.potOfGreedMatch) return { handled: false };
    const payload = parse(value);
    if (messageType === "pot_of_greed_vault_action") {
      if (!payload) return { handled: true, error: { code: "BAD_PAYLOAD", message: "Vault action payload must be JSON." } };
      lobby.potOfGreedMatch = submitPotOfGreedVaultAction(lobby.potOfGreedMatch, clientId, payload);
      sendState(lobby);
      return { handled: true };
    }
    if (messageType === "pot_of_greed_vote") {
      if (!payload?.targetId) return { handled: true, error: { code: "BAD_PAYLOAD", message: "Vote payload requires a targetId." } };
      lobby.potOfGreedMatch = submitPotOfGreedVote(lobby.potOfGreedMatch, clientId, payload.targetId);
      sendState(lobby);
      return { handled: true };
    }
    return { handled: false };
  },

  isMatchPendingStart() { return false; },
  cancelPendingStart() {},
  hasActiveMatch(lobby) { return !!lobby?.potOfGreedMatch; },

  applyDisconnect(lobby, clientId, now) {
    if (!lobby?.potOfGreedMatch) return false;
    lobby.potOfGreedMatch = applyPotOfGreedConnection(lobby.potOfGreedMatch, clientId, false, now);
    return true;
  },

  applyReconnect(lobby, clientId, now) {
    if (!lobby?.potOfGreedMatch) return false;
    lobby.potOfGreedMatch = applyPotOfGreedConnection(lobby.potOfGreedMatch, clientId, true, now);
    return true;
  },

  broadcastAfterLeave(lobby) { sendState(lobby); },
  broadcastAfterReconnect(lobby) { sendState(lobby); },
  clearTimers(lobby) { clearPhaseTimer(lobby); },
};
