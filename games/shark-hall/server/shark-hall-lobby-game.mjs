// The adapter: everything the pure match engine deliberately refuses to do.
//
// Sockets, broadcasts, lobby status, and the one decision the engine cannot make
// on its own — whether a message is even allowed to reach it. The engine beside
// this file is state in, state out; this is the only place a side effect lives.
//
// THE AUTHORITY LINE IS AT THE BOTTOM OF `handleMessage`. A client may send a
// stroke and a rematch request, and nothing else: every message that would state
// an outcome — a settled table, a foul, a rack winner — is answered with
// SERVER_AUTHORITY rather than ignored, so a client built against the wrong
// model fails loudly on its first frame instead of quietly disagreeing for a
// whole rack.

import { broadcastToLobby, sendLobbyUpdated } from "../../../src/lobby-bus.mjs";
import {
  SHARK_HALL_GAME_ID,
  SHARK_HALL_PROTOCOL_VERSION,
  SHARK_HALL_RECONNECT_GRACE_MS,
  PHASE_COMPLETE,
  applySharkDisconnect,
  applySharkReconnect,
  applySharkShot,
  createSharkMatchState,
  requestSharkRematch,
  serializeSharkMatch,
} from "./shark-hall-match-engine.mjs";

function parseValue(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function publish(lobby, messageType, payload) {
  broadcastToLobby(lobby.roomCode, {
    event: "message",
    scope: "lobby",
    messageType,
    value: JSON.stringify(payload),
    senderId: "server",
    roomCode: lobby.roomCode,
  });
}

function broadcastMatch(lobby, messageType = "shark_match") {
  if (!lobby?.sharkMatch) return;
  publish(lobby, messageType, serializeSharkMatch(lobby.sharkMatch, Date.now()));
}

function syncLobbyStatus(lobby) {
  if (!lobby?.sharkMatch) return;
  lobby.status = lobby.sharkMatch.phase === PHASE_COMPLETE ? "ended" : "started";
}

export const sharkHallLobbyGame = {
  gameId: SHARK_HALL_GAME_ID,
  // Two seats, always. It is one table with one cue ball on it; there is no
  // arrangement of this game that seats a third player, so the limit is a fact
  // rather than a default. Clients must send these limits on `find_lobby` too —
  // a search that omits them is sanitized to the server-wide 2-6 and silently
  // matches nothing.
  lobbyLimits: { minPlayers: 2, maxPlayers: 2 },
  reconnectGracePeriodMs: SHARK_HALL_RECONNECT_GRACE_MS,

  canStart(lobby) {
    if (Number(lobby?.settings?.protocolVersion) !== SHARK_HALL_PROTOCOL_VERSION) return false;
    // Both seats have to have announced the same protocol. A client that
    // predates the authoritative model would send strokes this server scores
    // correctly and then draw a table of its own invention.
    return [...(lobby?.members || [])].every(
      (clientId) => lobby?.sharkProfiles?.get(clientId)?.protocolVersion === SHARK_HALL_PROTOCOL_VERSION,
    );
  },

  initMatch(lobby, startAt) {
    lobby.sharkMatch = createSharkMatchState(lobby, startAt);
    syncLobbyStatus(lobby);
  },

  afterStart(lobby) {
    broadcastMatch(lobby);
  },

  startedPayloadExtras(lobby, serverNow) {
    return lobby?.sharkMatch
      ? { authorityMode: "server", matchState: serializeSharkMatch(lobby.sharkMatch, serverNow) }
      : {};
  },

  handleMessage(lobby, clientId, messageType, value) {
    if (messageType === "shark_profile") {
      const raw = parseValue(value);
      if (!(lobby.sharkProfiles instanceof Map)) lobby.sharkProfiles = new Map();
      lobby.sharkProfiles.set(clientId, { protocolVersion: Number(raw?.protocolVersion) || 0 });
      sendLobbyUpdated(lobby);
      return { handled: true };
    }

    if (messageType === "shark_shot") {
      const applied = applySharkShot(lobby.sharkMatch, clientId, parseValue(value));
      if (applied.error) return { handled: true, error: applied.error };
      lobby.sharkMatch = applied.match;
      syncLobbyStatus(lobby);
      // ONE message carries the stroke and its consequence. The clients replay
      // the stroke to animate it and hold the state until their own replay
      // settles, so splitting these would only give them a chance to draw the
      // answer before the shot.
      publish(lobby, "shark_shot_played", {
        ...applied.shot,
        match: serializeSharkMatch(applied.match, Date.now()),
      });
      if (lobby.status === "ended") sendLobbyUpdated(lobby);
      return { handled: true };
    }

    if (messageType === "shark_rematch") {
      const rematch = requestSharkRematch(lobby.sharkMatch, clientId);
      lobby.sharkMatch = rematch.match;
      syncLobbyStatus(lobby);
      broadcastMatch(lobby);
      if (rematch.started) sendLobbyUpdated(lobby);
      return { handled: true };
    }

    if (["shark_match", "shark_match_ended", "shark_shot_played", "shark_result"].includes(messageType)) {
      return {
        handled: true,
        error: {
          code: "SERVER_AUTHORITY",
          message: "Shark Hall plays every shot on the Factory Network server.",
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
    return Boolean(lobby?.sharkMatch);
  },

  applyDisconnect(lobby, clientId, now) {
    if (!lobby?.sharkMatch) return false;
    let next = applySharkDisconnect(lobby.sharkMatch, clientId, now);
    // A suspended socket stays in lobby.members for the grace window. If the
    // generic leave has already removed it, this is a real departure rather than
    // a drop, and the match settles now instead of holding a table forever.
    if (!lobby.members?.has(clientId) && next?.phase !== PHASE_COMPLETE) {
      next = applySharkDisconnect(next, clientId, now);
    }
    if (next === lobby.sharkMatch) return false;
    lobby.sharkMatch = next;
    syncLobbyStatus(lobby);
    return true;
  },

  applyReconnect(lobby, clientId, now) {
    if (!lobby?.sharkMatch) return false;
    const next = applySharkReconnect(lobby.sharkMatch, clientId, now);
    if (next === lobby.sharkMatch) return false;
    lobby.sharkMatch = next;
    syncLobbyStatus(lobby);
    return true;
  },

  broadcastAfterLeave(lobby) {
    broadcastMatch(lobby, lobby?.status === "ended" ? "shark_match_ended" : "shark_match");
    if (lobby?.status === "ended") sendLobbyUpdated(lobby);
  },

  broadcastAfterReconnect(lobby) {
    broadcastMatch(lobby);
  },

  clearTimers() {},
};
