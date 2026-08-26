// The lobby adapter for online HORSE.
//
// Thinner than its sibling `mini-hoops-lobby-game.mjs` in exactly one way, and
// it is the interesting one: HORSE HAS NO CLOCK. The classic cabinet's online
// mode schedules a deadline the moment it starts and the server owns the buzzer;
// a HORSE match ends when somebody spells the word, which is a consequence of a
// shot rather than of time passing. So there are no timers here at all.
import { broadcastToLobby, sendLobbyUpdated } from "../../../src/lobby-bus.mjs";
import {
  HORSE_GAME_ID,
  HORSE_RECONNECT_GRACE_MS,
  applyHorseDisconnect,
  applyHorsePlacement,
  applyHorseReconnect,
  applyHorseShot,
  createHorseMatchState,
  serializeHorseMatch,
} from "./horse-match-engine.mjs";

function parse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function broadcastMatch(lobby, ended = false) {
  if (!lobby?.horseMatch) return;
  broadcastToLobby(lobby.roomCode, {
    event: "message",
    scope: "lobby",
    roomCode: lobby.roomCode,
    messageType: ended ? "horse_match_ended" : "horse_match",
    value: JSON.stringify(serializeHorseMatch(lobby.horseMatch)),
  });
}

function commit(lobby, next) {
  if (next === lobby.horseMatch) return false;
  lobby.horseMatch = next;
  if (next.phase === "complete") lobby.status = "ended";
  broadcastMatch(lobby, next.phase === "complete");
  return true;
}

export const horseLobbyGame = {
  gameId: HORSE_GAME_ID,
  lobbyLimits: { minPlayers: 2, maxPlayers: 2 },
  reconnectGracePeriodMs: HORSE_RECONNECT_GRACE_MS,

  initMatch(lobby, startAt) {
    lobby.horseMatch = createHorseMatchState(lobby, startAt);
  },
  startedPayloadExtras(lobby, serverNow) {
    return { authorityMode: "server", matchState: serializeHorseMatch(lobby.horseMatch, serverNow) };
  },
  handleMessage(lobby, clientId, messageType, value) {
    if (messageType === "horse_placement") {
      commit(lobby, applyHorsePlacement(lobby.horseMatch, clientId, parse(value)));
      return { handled: true };
    }
    if (messageType === "horse_shot") {
      commit(lobby, applyHorseShot(lobby.horseMatch, clientId, parse(value), Date.now()));
      return { handled: true };
    }
    // The whole point of the mirror: a browser may describe a pull, never an
    // outcome, a letter, or a turn.
    if (["horse_result", "horse_letters", "horse_match", "horse_match_ended"].includes(messageType)) {
      return {
        handled: true,
        error: { code: "SERVER_AUTHORITY", message: "HORSE outcomes are server authoritative." },
      };
    }
    return { handled: false };
  },
  hasActiveMatch(lobby) { return Boolean(lobby?.horseMatch); },
  applyDisconnect(lobby, clientId) {
    const next = applyHorseDisconnect(lobby.horseMatch, clientId);
    if (next === lobby.horseMatch) return false;
    lobby.horseMatch = next;
    if (next.phase === "complete") lobby.status = "ended";
    return true;
  },
  applyReconnect(lobby, clientId) {
    const next = applyHorseReconnect(lobby.horseMatch, clientId);
    if (next === lobby.horseMatch) return false;
    lobby.horseMatch = next;
    broadcastMatch(lobby, false);
    return true;
  },
  broadcastAfterLeave(lobby) {
    broadcastMatch(lobby, lobby.horseMatch?.phase === "complete");
    sendLobbyUpdated(lobby);
  },
};
