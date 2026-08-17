import { broadcastToLobby, sendLobbyUpdated } from "../../../src/lobby-bus.mjs";
import {
  YAM_BOWLING_GAME_ID,
  YAM_BOWLING_PROTOCOL_VERSION,
  YAM_BOWLING_RECONNECT_GRACE_MS,
  applyYamDisconnect,
  applyYamReaction,
  applyYamReconnect,
  applyYamShot,
  createYamMatchState,
  reactionWheels,
  requestYamRematch,
  serializeYamMatch,
} from "./yam-bowling-match-engine.mjs";

function parseValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function sanitizeYamProfile(lobby, clientId, raw) {
  const canonical = lobby?.memberProfiles?.get(clientId) || {};
  const characterSlug = cleanText(raw?.characterSlug, 64).toLowerCase();
  const skinId = cleanText(raw?.skinId, 40).toLowerCase();
  const presentationValue = (value, prefix, fallback) => {
    const text = cleanText(value, 96).toLowerCase();
    return new RegExp(`^${prefix}:[a-z0-9-]{1,64}$`).test(text) ? text : fallback;
  };
  const resolvedCharacterSlug = /^[a-z0-9-]{1,64}$/.test(characterSlug) ? characterSlug : "daisy-monroe";
  const victoryPoseId = cleanText(raw?.presentation?.victoryPoseId, 96).toLowerCase();
  return {
    // The Factory identity accepted at lobby entry stays canonical. A later
    // profile message may select a bowler, but cannot swap the account id.
    playerId: cleanText(canonical.playerId, 64),
    displayName: cleanText(canonical.displayName, 24) || "Player",
    characterSlug: resolvedCharacterSlug,
    // The server carries the equipped skin without owning the skin catalog: the
    // slug shape is all it can check, and the client falls back to the classic
    // look for any id it does not know.
    skinId: /^[a-z0-9-]{1,40}$/.test(skinId) ? skinId : "canon",
    presentation: {
      ballTrailId: presentationValue(raw?.presentation?.ballTrailId, "ball-trail", "ball-trail:none"),
      strikeBurstId: presentationValue(raw?.presentation?.strikeBurstId, "strike-burst", "strike-burst:classic"),
      victoryPoseId: victoryPoseId.startsWith(`victory-pose:${resolvedCharacterSlug}:`)
        && /^victory-pose:[a-z0-9-]+:[a-z0-9-]+$/.test(victoryPoseId)
        ? victoryPoseId
        : `victory-pose:${resolvedCharacterSlug}:canon`,
      // The reaction wheels: exactly four ids each, always, so the slot index a
      // client sends mid-match is checked against a fixed length rather than
      // against whatever list happened to arrive. Padding a short wheel here is
      // what lets a client that predates the wheels still react instead of
      // erroring. The padding rule itself lives in the match engine so this
      // sanitizer and the one that freezes a match cannot disagree.
      ...reactionWheels(raw?.presentation, presentationValue),
      playerCardId: presentationValue(raw?.presentation?.playerCardId, "player-card", `player-card:${resolvedCharacterSlug}`),
      profileIconId: presentationValue(raw?.presentation?.profileIconId, "profile-icon", ""),
      entranceId: presentationValue(raw?.presentation?.entranceId, "entrance", ""),
    },
    protocolVersion: Number(raw?.protocolVersion) || 0,
  };
}

function broadcastMatch(lobby, messageType = "yam_match") {
  if (!lobby?.yamMatch) return;
  broadcastToLobby(lobby.roomCode, {
    event: "message",
    scope: "lobby",
    messageType,
    value: JSON.stringify(serializeYamMatch(lobby.yamMatch, lobby, Date.now())),
    senderId: "server",
    roomCode: lobby.roomCode,
  });
}

function syncLobbyStatus(lobby) {
  if (!lobby?.yamMatch) return;
  lobby.status = lobby.yamMatch.phase === "complete" ? "ended" : "started";
}

export const yamBowlingLobbyGame = {
  gameId: YAM_BOWLING_GAME_ID,
  lobbyLimits: { minPlayers: 2, maxPlayers: 2 },
  reconnectGracePeriodMs: YAM_BOWLING_RECONNECT_GRACE_MS,

  canStart(lobby) {
    if (![1, YAM_BOWLING_PROTOCOL_VERSION].includes(Number(lobby?.settings?.protocolVersion))) return false;
    return [...(lobby?.members || [])].every((clientId) =>
      [1, YAM_BOWLING_PROTOCOL_VERSION].includes(lobby?.yamProfiles?.get(clientId)?.protocolVersion)
    );
  },

  initMatch(lobby, startAt) {
    lobby.yamMatch = createYamMatchState(lobby, startAt);
    syncLobbyStatus(lobby);
  },

  afterStart(lobby) {
    broadcastMatch(lobby);
  },

  startedPayloadExtras(lobby, serverNow) {
    return lobby?.yamMatch
      ? { authorityMode: "server", matchState: serializeYamMatch(lobby.yamMatch, lobby, serverNow) }
      : {};
  },

  handleMessage(lobby, clientId, messageType, value) {
    if (messageType === "yam_profile") {
      const profile = sanitizeYamProfile(lobby, clientId, parseValue(value));
      if (!(lobby.yamProfiles instanceof Map)) lobby.yamProfiles = new Map();
      lobby.yamProfiles.set(clientId, profile);
      // Publish the look to the lobby roster so the other bowler sees the
      // chosen character and skin on the pre-match card, not just in play.
      if (!(lobby.publicPlayerFields instanceof Map)) lobby.publicPlayerFields = new Map();
      lobby.publicPlayerFields.set(clientId, {
        characterSlug: profile.characterSlug,
        skinId: profile.skinId,
        presentation: profile.presentation,
      });
      sendLobbyUpdated(lobby);
      return { handled: true };
    }

    if (messageType === "yam_shot") {
      const applied = applyYamShot(lobby.yamMatch, clientId, parseValue(value), Date.now());
      if (applied.error) return { handled: true, error: applied.error };
      lobby.yamMatch = applied.match;
      syncLobbyStatus(lobby);
      broadcastMatch(lobby, lobby.status === "ended" ? "yam_match_ended" : "yam_match");
      if (lobby.status === "ended") sendLobbyUpdated(lobby);
      return { handled: true };
    }

    if (messageType === "yam_reaction") {
      const request = parseValue(value);
      const applied = applyYamReaction(lobby.yamMatch, clientId, request?.kind, request?.slot, Date.now());
      if (applied.error) return { handled: true, error: applied.error };
      lobby.yamMatch = applied.match;
      broadcastToLobby(lobby.roomCode, {
        event: "message",
        scope: "lobby",
        messageType: "yam_reaction",
        value: JSON.stringify(applied.event),
        senderId: "server",
        roomCode: lobby.roomCode,
      });
      return { handled: true };
    }

    if (messageType === "yam_rematch") {
      const rematch = requestYamRematch(lobby.yamMatch, clientId, Date.now());
      lobby.yamMatch = rematch.match;
      syncLobbyStatus(lobby);
      broadcastMatch(lobby);
      if (rematch.started) sendLobbyUpdated(lobby);
      return { handled: true };
    }

    if (messageType === "yam_match" || messageType === "yam_match_ended" || messageType === "yam_roll_result") {
      return {
        handled: true,
        error: { code: "SERVER_AUTHORITY", message: "Yam Bowling scores rolls on the Factory Network server." },
      };
    }
    return { handled: false };
  },

  isMatchPendingStart() {
    return false;
  },

  cancelPendingStart() {},

  hasActiveMatch(lobby) {
    return Boolean(lobby?.yamMatch);
  },

  applyDisconnect(lobby, clientId, now) {
    if (!lobby?.yamMatch) return false;
    let next = applyYamDisconnect(lobby.yamMatch, clientId, now);
    // A suspended socket remains in lobby.members during the grace window. If
    // generic leave already removed it, this is an explicit leave/expiry and
    // the match should settle immediately instead of pausing forever.
    if (!lobby.members?.has(clientId) && next?.phase === "paused") {
      next = applyYamDisconnect(next, clientId, now);
    }
    if (next === lobby.yamMatch) return false;
    lobby.yamMatch = next;
    syncLobbyStatus(lobby);
    return true;
  },

  applyReconnect(lobby, clientId, now) {
    if (!lobby?.yamMatch) return false;
    const next = applyYamReconnect(lobby.yamMatch, clientId, now);
    if (next === lobby.yamMatch) return false;
    lobby.yamMatch = next;
    syncLobbyStatus(lobby);
    return true;
  },

  broadcastAfterLeave(lobby) {
    broadcastMatch(lobby, lobby?.status === "ended" ? "yam_match_ended" : "yam_match");
    if (lobby?.status === "ended") sendLobbyUpdated(lobby);
  },

  broadcastAfterReconnect(lobby) {
    broadcastMatch(lobby);
  },

  clearTimers() {},
};
