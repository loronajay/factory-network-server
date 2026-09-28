import { sendLobbyUpdated } from "../../../src/lobby-bus.mjs";
import {
  PONDSIDE_GAME_ID,
  PONDSIDE_LOBBY_LIMITS,
  advancePondsideMatch,
  applyPondsideDisconnect,
  applyPondsideInput,
  applyPondsideReconnect,
  createPondsideMatch,
  serializePondsideMatch,
} from "./pondside-push-match-engine.mjs";
import { PET_GAMES_RECONNECT_GRACE_MS, broadcastState, parse, rememberPet, startTicking, stopTicking } from "./pet-lobby-kit.mjs";

// A Pondside Push match is a continuously ticking world: one interval per match
// advances the mirrored session.js and publishes a snapshot. Every shove, splash
// and round is decided inside that advance, never in a message handler.
const TIMER = "pondsideTimer";
const SNAPSHOT = "pondside_snapshot";
const ENDED = "pondside_match_ended";

function tick(lobby) {
  startTicking(lobby, TIMER, {
    label: PONDSIDE_GAME_ID,
    messageType: SNAPSHOT,
    endedMessageType: ENDED,
    advance: (now) => advancePondsideMatch(lobby.pondsideMatch, now),
    serialize: () => serializePondsideMatch(lobby.pondsideMatch),
  });
}

const live = (lobby) => Boolean(lobby?.pondsideMatch) && lobby.pondsideMatch.phase !== "complete";

export const pondsidePushLobbyGame = {
  gameId: PONDSIDE_GAME_ID,
  lobbyLimits: PONDSIDE_LOBBY_LIMITS,
  reconnectGracePeriodMs: PET_GAMES_RECONNECT_GRACE_MS,

  initMatch(lobby, startAt) {
    lobby.pondsideMatch = createPondsideMatch(lobby, startAt);
  },
  afterStart(lobby) { tick(lobby); },
  startedPayloadExtras(lobby, serverNow) {
    return { authorityMode: "server", matchState: serializePondsideMatch(lobby.pondsideMatch, serverNow) };
  },
  handleMessage(lobby, clientId, messageType, value) {
    if (messageType === "pet_profile") {
      if (live(lobby)) return { handled: true };
      rememberPet(lobby, clientId, parse(value)?.pet);
      return { handled: true };
    }
    if (messageType === "pondside_input") {
      applyPondsideInput(lobby.pondsideMatch, clientId, parse(value));
      return { handled: true };
    }
    if (["pondside_state", "pondside_snapshot", "pondside_match_ended", "pondside_splash", "pondside_result", "state_sync"].includes(messageType)) {
      return { handled: true, error: { code: "SERVER_AUTHORITY", message: "Pondside Push matches are decided by the server." } };
    }
    return { handled: false };
  },
  hasActiveMatch: live,
  applyDisconnect(lobby, clientId) {
    return applyPondsideDisconnect(lobby?.pondsideMatch, clientId, lobby?.members?.has(clientId) === true);
  },
  applyReconnect(lobby, clientId) {
    return applyPondsideReconnect(lobby?.pondsideMatch, clientId);
  },
  broadcastAfterReconnect(lobby) {
    if (lobby?.pondsideMatch) broadcastState(lobby, live(lobby) ? SNAPSHOT : ENDED, serializePondsideMatch(lobby.pondsideMatch));
    sendLobbyUpdated(lobby);
    return true;
  },
  broadcastAfterLeave(lobby) {
    if (lobby?.pondsideMatch) broadcastState(lobby, live(lobby) ? SNAPSHOT : ENDED, serializePondsideMatch(lobby.pondsideMatch));
    sendLobbyUpdated(lobby);
  },
  clearTimers(lobby) { stopTicking(lobby, TIMER); },
};
