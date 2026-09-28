import { sendLobbyUpdated } from "../../../src/lobby-bus.mjs";
import {
  BARNYARD_GAME_ID,
  BARNYARD_LOBBY_LIMITS,
  advanceBarnyardMatch,
  applyBarnyardDisconnect,
  applyBarnyardInput,
  applyBarnyardReconnect,
  createBarnyardMatch,
  serializeBarnyardMatch,
} from "./barnyard-dash-match-engine.mjs";
import { PET_GAMES_RECONNECT_GRACE_MS, broadcastState, parse, rememberPet, startTicking, stopTicking } from "./pet-lobby-kit.mjs";

// A Barnyard Dash race is a continuously ticking world, so the lobby holds one
// interval per race that advances the mirrored race.js and publishes a snapshot.
// Everything authoritative happens inside that advance, never in a message handler.
const TIMER = "barnyardTimer";
const SNAPSHOT = "barnyard_snapshot";
const ENDED = "barnyard_match_ended";

function tick(lobby) {
  startTicking(lobby, TIMER, {
    label: BARNYARD_GAME_ID,
    messageType: SNAPSHOT,
    endedMessageType: ENDED,
    advance: (now) => advanceBarnyardMatch(lobby.barnyardMatch, now),
    serialize: () => serializeBarnyardMatch(lobby.barnyardMatch),
  });
}

const live = (lobby) => Boolean(lobby?.barnyardMatch) && lobby.barnyardMatch.phase !== "complete";

export const barnyardDashLobbyGame = {
  gameId: BARNYARD_GAME_ID,
  lobbyLimits: BARNYARD_LOBBY_LIMITS,
  reconnectGracePeriodMs: PET_GAMES_RECONNECT_GRACE_MS,

  initMatch(lobby, startAt) {
    lobby.barnyardMatch = createBarnyardMatch(lobby, startAt);
  },
  afterStart(lobby) { tick(lobby); },
  startedPayloadExtras(lobby, serverNow) {
    return { authorityMode: "server", matchState: serializeBarnyardMatch(lobby.barnyardMatch, serverNow) };
  },
  handleMessage(lobby, clientId, messageType, value) {
    if (messageType === "pet_profile") {
      // The pet is chosen in the lobby; once the race is on, the grid is fixed.
      if (live(lobby)) return { handled: true };
      rememberPet(lobby, clientId, parse(value)?.pet);
      return { handled: true };
    }
    if (messageType === "barnyard_input") {
      applyBarnyardInput(lobby.barnyardMatch, clientId, parse(value));
      return { handled: true };
    }
    // What a client must never assert: where a pet is, what it cleared, when it finished, who won.
    if (["barnyard_state", "barnyard_snapshot", "barnyard_match_ended", "barnyard_finish", "barnyard_result", "state_sync"].includes(messageType)) {
      return { handled: true, error: { code: "SERVER_AUTHORITY", message: "Barnyard Dash races are decided by the server." } };
    }
    return { handled: false };
  },
  hasActiveMatch: live,
  applyDisconnect(lobby, clientId) {
    // Suspended (still a member, in its grace window) coasts; gone for good retires.
    return applyBarnyardDisconnect(lobby?.barnyardMatch, clientId, lobby?.members?.has(clientId) === true);
  },
  applyReconnect(lobby, clientId) {
    return applyBarnyardReconnect(lobby?.barnyardMatch, clientId);
  },
  broadcastAfterReconnect(lobby) {
    if (lobby?.barnyardMatch) broadcastState(lobby, live(lobby) ? SNAPSHOT : ENDED, serializeBarnyardMatch(lobby.barnyardMatch));
    sendLobbyUpdated(lobby);
    return true;
  },
  broadcastAfterLeave(lobby) {
    if (lobby?.barnyardMatch) broadcastState(lobby, live(lobby) ? SNAPSHOT : ENDED, serializeBarnyardMatch(lobby.barnyardMatch));
    sendLobbyUpdated(lobby);
  },
  clearTimers(lobby) { stopTicking(lobby, TIMER); },
};
