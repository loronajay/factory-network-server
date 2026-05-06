export const CIRCUIT_SIEGE_GAME_ID = "circuit-siege";

function sanitizeText(value, maxLength = 24) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

export function sanitizeIdentityPayload(identity) {
  if (!identity || typeof identity !== "object") {
    return {};
  }

  const payload = {};
  const playerId = sanitizeText(identity.playerId, 64);
  const displayName = sanitizeText(identity.displayName, 24);

  if (playerId) {
    payload.playerId = playerId;
  }

  if (displayName) {
    payload.displayName = displayName;
  }

  return payload;
}

export function buildFindMatchPayload(side, gameId = CIRCUIT_SIEGE_GAME_ID, identity = null) {
  return {
    type: "find_match",
    gameId,
    side,
    ...sanitizeIdentityPayload(identity)
  };
}

export function buildCreateRoomPayload(side, identity = null) {
  return {
    type: "create_room",
    side,
    ...sanitizeIdentityPayload(identity)
  };
}

export function buildJoinRoomPayload(side, code, identity = null) {
  return {
    type: "join_room",
    roomCode: sanitizeText(code, 16).toUpperCase(),
    side,
    ...sanitizeIdentityPayload(identity)
  };
}

export function buildQueueStatusPayload(gameId = CIRCUIT_SIEGE_GAME_ID) {
  return {
    type: "queue_status",
    gameId
  };
}

export function serializeProfileMessage(identity, side) {
  return JSON.stringify({
    playerId: sanitizeText(identity?.playerId, 64),
    displayName: sanitizeText(identity?.displayName, 24),
    side: sanitizeText(side, 12) || null
  });
}

export function parseProfileMessage(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const displayName = sanitizeText(parsed.displayName, 24);
    if (!displayName) {
      return null;
    }

    return {
      playerId: sanitizeText(parsed.playerId, 64),
      displayName,
      side: sanitizeText(parsed.side, 12) || null
    };
  } catch {
    return null;
  }
}

export function serializeCircuitActionIntent(intent) {
  return JSON.stringify(intent || {});
}

export function parseCircuitActionIntent(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    if (typeof parsed.intentType !== "string" || parsed.intentType.length === 0) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}
