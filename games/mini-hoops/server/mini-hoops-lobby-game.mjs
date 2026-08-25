import { broadcastToLobby, sendLobbyUpdated } from "../../../src/lobby-bus.mjs";
import {
  MINI_HOOPS_GAME_ID,
  MINI_HOOPS_RECONNECT_GRACE_MS,
  applyMiniHoopsDisconnect,
  applyMiniHoopsReconnect,
  applyMiniHoopsShot,
  createMiniHoopsMatchState,
  finalizeMiniHoopsMatch,
  serializeMiniHoopsMatch,
} from "./mini-hoops-match-engine.mjs";

function parse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function broadcastMatch(lobby, ended = false) {
  if (!lobby?.miniHoopsMatch) return;
  broadcastToLobby(lobby.roomCode, {
    event: "message",
    scope: "lobby",
    roomCode: lobby.roomCode,
    messageType: ended ? "mini_hoops_match_ended" : "mini_hoops_match",
    value: JSON.stringify(serializeMiniHoopsMatch(lobby.miniHoopsMatch)),
  });
}

function scheduleDeadline(lobby) {
  const delay = Math.max(0, lobby.miniHoopsMatch.endsAt - Date.now());
  lobby.miniHoopsDeadline = setTimeout(() => {
    lobby.miniHoopsMatch = finalizeMiniHoopsMatch(lobby.miniHoopsMatch, Date.now());
    lobby.status = "ended";
    broadcastMatch(lobby, true);
    sendLobbyUpdated(lobby);
  }, delay);
  lobby.miniHoopsDeadline.unref?.();
}

export const miniHoopsLobbyGame = {
  gameId: MINI_HOOPS_GAME_ID,
  lobbyLimits: { minPlayers: 2, maxPlayers: 2 },
  reconnectGracePeriodMs: MINI_HOOPS_RECONNECT_GRACE_MS,

  initMatch(lobby, startAt) {
    lobby.miniHoopsMatch = createMiniHoopsMatchState(lobby, startAt);
  },
  afterStart(lobby) { scheduleDeadline(lobby); },
  startedPayloadExtras(lobby, serverNow) {
    return { authorityMode: "server", matchState: serializeMiniHoopsMatch(lobby.miniHoopsMatch, serverNow) };
  },
  handleMessage(lobby, clientId, messageType, value) {
    if (messageType === "mini_hoops_shot") {
      const next = applyMiniHoopsShot(lobby.miniHoopsMatch, clientId, parse(value), Date.now());
      if (next !== lobby.miniHoopsMatch) {
        lobby.miniHoopsMatch = next;
        broadcastMatch(lobby, false);
      }
      return { handled: true };
    }
    if (["mini_hoops_score", "mini_hoops_result", "mini_hoops_match", "mini_hoops_match_ended"].includes(messageType)) {
      return { handled: true, error: { code: "SERVER_AUTHORITY", message: "Mini Hoops scores and results are server authoritative." } };
    }
    return { handled: false };
  },
  hasActiveMatch(lobby) { return Boolean(lobby?.miniHoopsMatch); },
  applyDisconnect(lobby, clientId, now) {
    const next = applyMiniHoopsDisconnect(lobby.miniHoopsMatch, clientId, now);
    if (next === lobby.miniHoopsMatch) return false;
    lobby.miniHoopsMatch = next;
    if (next.phase === "complete") lobby.status = "ended";
    return true;
  },
  applyReconnect(lobby, clientId) {
    const next = applyMiniHoopsReconnect(lobby.miniHoopsMatch, clientId);
    if (next === lobby.miniHoopsMatch) return false;
    lobby.miniHoopsMatch = next;
    broadcastMatch(lobby, false);
    return true;
  },
  broadcastAfterLeave(lobby) {
    broadcastMatch(lobby, lobby.miniHoopsMatch?.phase === "complete");
    sendLobbyUpdated(lobby);
  },
  clearTimers(lobby) {
    if (lobby?.miniHoopsDeadline) clearTimeout(lobby.miniHoopsDeadline);
    if (lobby) lobby.miniHoopsDeadline = null;
  },
};
