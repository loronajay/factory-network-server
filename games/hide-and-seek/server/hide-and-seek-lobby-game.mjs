import { broadcastToLobby, sendLobbyUpdated } from "../../../src/lobby-bus.mjs";
import {
  HIDE_AND_SEEK_GAME_ID,
  HIDE_AND_SEEK_LOBBY_LIMITS,
  HIDE_AND_SEEK_RECONNECT_GRACE_MS,
  HIDE_AND_SEEK_SNAPSHOT_HZ,
  advanceHideAndSeekMatch,
  applyHideAndSeekDisconnect,
  applyHideAndSeekInput,
  applyHideAndSeekReconnect,
  createHideAndSeekMatchState,
  serializeHideAndSeekMatch,
} from "./hide-and-seek-match-engine.mjs";

// Hide and Seek is the first cabinet here whose match is a *continuously ticking world* rather than
// a sequence of turns. The lobby holds one interval per match: it advances the mirrored simulation
// and publishes a snapshot. Everything authoritative — walking, line of sight, the head start, the
// catch — happens inside that advance, never in a message handler.
const SNAPSHOT_INTERVAL_MS = Math.round(1000 / HIDE_AND_SEEK_SNAPSHOT_HZ);

function parse(value) {
  try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
}

function broadcastMatch(lobby, ended = false) {
  if (!lobby?.hideAndSeekMatch) return;
  broadcastToLobby(lobby.roomCode, {
    event: "message",
    scope: "lobby",
    roomCode: lobby.roomCode,
    messageType: ended ? "hide_and_seek_match_ended" : "hide_and_seek_snapshot",
    value: JSON.stringify(serializeHideAndSeekMatch(lobby.hideAndSeekMatch)),
  });
}

function stopTicking(lobby) {
  if (lobby?.hideAndSeekTimer) clearInterval(lobby.hideAndSeekTimer);
  if (lobby) lobby.hideAndSeekTimer = null;
}

function startTicking(lobby) {
  stopTicking(lobby);
  lobby.hideAndSeekTimer = setInterval(() => {
    // Anything escaping here would take down every match on the server, not just this one.
    try {
      const match = lobby.hideAndSeekMatch;
      if (!match) { stopTicking(lobby); return; }
      const wasComplete = match.phase === "complete";
      advanceHideAndSeekMatch(match, Date.now());
      const ended = match.phase === "complete";
      broadcastMatch(lobby, ended && !wasComplete);
      if (ended) {
        stopTicking(lobby);
        lobby.status = "ended";
        sendLobbyUpdated(lobby);
      }
    } catch (error) {
      stopTicking(lobby);
      console.error("[hide-and-seek] tick failed", error);
    }
  }, SNAPSHOT_INTERVAL_MS);
  lobby.hideAndSeekTimer.unref?.();
}

export const hideAndSeekLobbyGame = {
  gameId: HIDE_AND_SEEK_GAME_ID,
  lobbyLimits: HIDE_AND_SEEK_LOBBY_LIMITS,
  reconnectGracePeriodMs: HIDE_AND_SEEK_RECONNECT_GRACE_MS,

  initMatch(lobby, startAt) {
    lobby.hideAndSeekMatch = createHideAndSeekMatchState(lobby, startAt);
  },
  afterStart(lobby) { startTicking(lobby); },
  startedPayloadExtras(lobby, serverNow) {
    return { authorityMode: "server", matchState: serializeHideAndSeekMatch(lobby.hideAndSeekMatch, serverNow) };
  },
  handleMessage(lobby, clientId, messageType, value) {
    if (messageType === "hide_and_seek_input") {
      applyHideAndSeekInput(lobby.hideAndSeekMatch, clientId, parse(value));
      return { handled: true };
    }
    // The three things a client must never assert: where it is, whether it was caught, and how much
    // battery it has left. All three are answers the tick gives.
    if (["hide_and_seek_pose", "hide_and_seek_caught", "hide_and_seek_snapshot", "hide_and_seek_match_ended"].includes(messageType)) {
      return { handled: true, error: { code: "SERVER_AUTHORITY", message: "Hide and Seek positions and catches are server authoritative." } };
    }
    return { handled: false };
  },
  hasActiveMatch(lobby) { return Boolean(lobby?.hideAndSeekMatch) && lobby.hideAndSeekMatch.phase !== "complete"; },
  applyDisconnect(lobby, clientId, now) {
    return applyHideAndSeekDisconnect(lobby?.hideAndSeekMatch, clientId, now);
  },
  applyReconnect(lobby, clientId) {
    return applyHideAndSeekReconnect(lobby?.hideAndSeekMatch, clientId);
  },
  broadcastAfterLeave(lobby) {
    broadcastMatch(lobby, lobby?.hideAndSeekMatch?.phase === "complete");
    sendLobbyUpdated(lobby);
  },
  clearTimers(lobby) { stopTicking(lobby); },
};
