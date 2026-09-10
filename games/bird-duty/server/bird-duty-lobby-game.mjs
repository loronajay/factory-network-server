import { broadcastToLobby, sendLobbyUpdated } from "../../../src/lobby-bus.mjs";
import {
  BIRD_DUTY_GAME_ID,
  BIRD_DUTY_LOBBY_LIMITS,
  BIRD_DUTY_RECONNECT_GRACE_MS,
  BIRD_DUTY_SNAPSHOT_HZ,
  advanceBirdDutyMatch,
  applyBirdDutyDisconnect,
  applyBirdDutyInput,
  applyBirdDutyReconnect,
  createBirdDutyMatchState,
  serializeBirdDutyMatch,
} from "./bird-duty-match-engine.mjs";

// Bird Duty's match is a continuously ticking world — walkers keep walking whether or not anyone is
// pressing a key — so the lobby holds one interval per match, the way hide-and-seek does. It
// advances the mirrored simulation and publishes a snapshot. Everything authoritative — the bird,
// the drop, the hit, the score, the turn order, the winner — happens inside that advance, never in
// a message handler.
const SNAPSHOT_INTERVAL_MS = Math.round(1000 / BIRD_DUTY_SNAPSHOT_HZ);

function parse(value) {
  try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
}

function broadcastMatch(lobby, ended = false) {
  if (!lobby?.birdDutyMatch) return;
  broadcastToLobby(lobby.roomCode, {
    event: "message",
    scope: "lobby",
    roomCode: lobby.roomCode,
    messageType: ended ? "bird_duty_match_ended" : "bird_duty_snapshot",
    value: JSON.stringify(serializeBirdDutyMatch(lobby.birdDutyMatch)),
  });
}

function stopTicking(lobby) {
  if (lobby?.birdDutyTimer) clearInterval(lobby.birdDutyTimer);
  if (lobby) lobby.birdDutyTimer = null;
}

function startTicking(lobby) {
  stopTicking(lobby);
  lobby.birdDutyTimer = setInterval(() => {
    // Anything escaping here would take down every match on the server, not just this one.
    try {
      const match = lobby.birdDutyMatch;
      if (!match) { stopTicking(lobby); return; }
      const wasComplete = match.phase === "complete";
      advanceBirdDutyMatch(match, Date.now());
      const ended = match.phase === "complete";
      broadcastMatch(lobby, ended && !wasComplete);
      if (ended) {
        stopTicking(lobby);
        lobby.status = "ended";
        sendLobbyUpdated(lobby);
      }
    } catch (error) {
      stopTicking(lobby);
      console.error("[bird-duty] tick failed", error);
    }
  }, SNAPSHOT_INTERVAL_MS);
  lobby.birdDutyTimer.unref?.();
}

export const birdDutyLobbyGame = {
  gameId: BIRD_DUTY_GAME_ID,
  lobbyLimits: BIRD_DUTY_LOBBY_LIMITS,
  reconnectGracePeriodMs: BIRD_DUTY_RECONNECT_GRACE_MS,

  initMatch(lobby, startAt) {
    lobby.birdDutyMatch = createBirdDutyMatchState(lobby, startAt);
  },
  afterStart(lobby) { startTicking(lobby); },
  startedPayloadExtras(lobby, serverNow) {
    return { authorityMode: "server", matchState: serializeBirdDutyMatch(lobby.birdDutyMatch, serverNow) };
  },
  handleMessage(lobby, clientId, messageType, value) {
    if (messageType === "bird_duty_input") {
      applyBirdDutyInput(lobby.birdDutyMatch, clientId, parse(value));
      return { handled: true };
    }
    // The things a client must never assert: where its bird is, what it hit, what it scored, and
    // whether the match is over. Every one of those is an answer the tick gives.
    if ([
      "bird_duty_state",
      "bird_duty_score",
      "bird_duty_hit",
      "bird_duty_snapshot",
      "bird_duty_match_ended",
      "state_sync",
    ].includes(messageType)) {
      return {
        handled: true,
        error: {
          code: "SERVER_AUTHORITY",
          message: "Bird Duty scores, hits and turn order are server authoritative.",
        },
      };
    }
    return { handled: false };
  },
  hasActiveMatch(lobby) {
    return Boolean(lobby?.birdDutyMatch) && lobby.birdDutyMatch.phase !== "complete";
  },
  applyDisconnect(lobby, clientId, now) {
    return applyBirdDutyDisconnect(lobby?.birdDutyMatch, clientId, now);
  },
  applyReconnect(lobby, clientId) {
    return applyBirdDutyReconnect(lobby?.birdDutyMatch, clientId);
  },
  // A resumed player walks back into a match that never stopped, so the first thing they need is the
  // world as it is now — not the lobby they left.
  broadcastAfterReconnect(lobby) {
    broadcastMatch(lobby, lobby?.birdDutyMatch?.phase === "complete");
    sendLobbyUpdated(lobby);
    return true;
  },
  broadcastAfterLeave(lobby) {
    broadcastMatch(lobby, lobby?.birdDutyMatch?.phase === "complete");
    sendLobbyUpdated(lobby);
  },
  clearTimers(lobby) { stopTicking(lobby); },
};
