// Build Buddy lobby-game adapter. Implements the lobby game-module interface
// (see src/lobby.mjs). Build Buddy public matches are server-authoritative:
// clients may not publish authoritative state or results.
import { broadcastToLobby, sendLobbyUpdated } from "../../../src/lobby-bus.mjs";
import {
  BUILD_BUDDY_GAME_ID,
  BUILD_BUDDY_PHASES,
  createBuildBuddyMatchState,
  applyBuildBuddyInputToMatch,
  applyBuildBuddyStageEventToMatch,
  applyBuildBuddyDisconnectToMatch,
  serializeBuildBuddyMatchState,
  serializeBuildBuddyStageStartMessage,
} from "./build-buddy-match-engine.mjs";

function broadcastBuildBuddyMatchState(lobby, messageType = "match_state") {
  if (!lobby?.buildBuddyMatch) return;
  lobby.buildBuddySyncSeq = Number(lobby.buildBuddySyncSeq || 0) + 1;
  const now = Date.now();
  const snapshot = messageType === "stage_start"
    ? serializeBuildBuddyStageStartMessage(lobby.buildBuddyMatch, lobby, now)
    : serializeBuildBuddyMatchState(lobby.buildBuddyMatch, lobby, now);
  broadcastToLobby(lobby.roomCode, {
    event: "message",
    scope: "lobby",
    messageType,
    value: JSON.stringify(snapshot),
    senderId: "server",
    roomCode: lobby.roomCode,
  });
}

export const buildBuddyLobbyGame = {
  gameId: BUILD_BUDDY_GAME_ID,

  initMatch(lobby, startAt) {
    lobby.buildBuddySyncSeq = 0;
    lobby.buildBuddyMatch = createBuildBuddyMatchState(lobby, startAt);
  },

  afterStart(lobby) {
    broadcastBuildBuddyMatchState(lobby, "stage_start");
  },

  startedPayloadExtras(lobby, serverNow) {
    if (!lobby.buildBuddyMatch) return {};
    return {
      authorityMode: "server",
      matchState: serializeBuildBuddyMatchState(lobby.buildBuddyMatch, lobby, serverNow),
    };
  },

  handleMessage(lobby, clientId, messageType, value) {
    if (messageType === "runner_input" || messageType === "builder_command") {
      const nextMatch = applyBuildBuddyInputToMatch(lobby.buildBuddyMatch, clientId, { messageType, value }, Date.now());
      if (nextMatch !== lobby.buildBuddyMatch) {
        lobby.buildBuddyMatch = nextMatch;
        broadcastBuildBuddyMatchState(lobby, "match_state");
      }
      return { handled: true };
    }

    if (messageType === "stage_complete_request") {
      const nextMatch = applyBuildBuddyStageEventToMatch(lobby.buildBuddyMatch, clientId, { messageType, value }, Date.now());
      if (nextMatch !== lobby.buildBuddyMatch) {
        lobby.buildBuddyMatch = nextMatch;
        lobby.status = nextMatch.phase === BUILD_BUDDY_PHASES.RUN_COMPLETE ? "ended" : "started";
        broadcastBuildBuddyMatchState(lobby, nextMatch.phase === BUILD_BUDDY_PHASES.RUN_COMPLETE ? "match_ended" : "stage_start");
        if (lobby.status === "ended") sendLobbyUpdated(lobby);
      }
      return { handled: true };
    }

    if (messageType === "state_sync" || messageType === "stage_result" || messageType === "run_complete" || messageType === "stage_start") {
      return {
        handled: true,
        error: {
          code: "SERVER_AUTHORITY",
          message: "Build Buddy public matches are server-authoritative; clients cannot publish authoritative state or results.",
        },
      };
    }

    return { handled: false };
  },

  isMatchPendingStart() {
    return false;
  },

  cancelPendingStart() {},

  hasActiveMatch(lobby) {
    return !!lobby?.buildBuddyMatch;
  },

  applyDisconnect(lobby, clientId, now) {
    if (!lobby.buildBuddyMatch) return false;
    const nextMatch = applyBuildBuddyDisconnectToMatch(lobby.buildBuddyMatch, clientId, now);
    if (nextMatch === lobby.buildBuddyMatch) return false;
    lobby.buildBuddyMatch = nextMatch;
    lobby.status = "ended";
    return true;
  },

  broadcastAfterLeave(lobby) {
    broadcastBuildBuddyMatchState(lobby, "match_ended");
    sendLobbyUpdated(lobby);
  },

  clearTimers() {},
};
