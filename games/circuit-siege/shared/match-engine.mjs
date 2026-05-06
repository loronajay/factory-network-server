import { getRoute, getRouteSlots } from "./circuit-board.mjs";
import { isRouteComplete } from "./route-validator.mjs";

const ROTATE_MASK = {
  EW: "NS",
  NS: "EW",
  NE: "ES",
  ES: "SW",
  SW: "NW",
  NW: "NE"
};

function wrongMask(expectedMask) {
  if (expectedMask === "EW") return "NS";
  if (expectedMask === "NS") return "EW";
  if (expectedMask === "NE") return "ES";
  if (expectedMask === "ES") return "SW";
  if (expectedMask === "SW") return "NW";
  return "NE";
}

function cloneState(state) {
  return {
    ...state,
    scores: { ...state.scores },
    routes: Object.fromEntries(Object.entries(state.routes).map(([id, route]) => [id, { ...route }])),
    terminals: Object.fromEntries(Object.entries(state.terminals).map(([id, terminal]) => [id, { ...terminal }])),
    slots: Object.fromEntries(Object.entries(state.slots).map(([id, slot]) => [id, { ...slot }]))
  };
}

function buildInitialSlotState(slot) {
  return {
    placedMask: slot.slotType === "hole" ? null : wrongMask(slot.expectedMask),
    locked: false
  };
}

function pieceMaskFromIntent(pieceType, rotation) {
  const normalizedRotation = ((Number(rotation) % 360) + 360) % 360;

  if (pieceType === "straight") {
    return normalizedRotation === 90 || normalizedRotation === 270 ? "NS" : "EW";
  }

  if (pieceType === "corner") {
    if (normalizedRotation === 0) return "NE";
    if (normalizedRotation === 90) return "ES";
    if (normalizedRotation === 180) return "SW";
    if (normalizedRotation === 270) return "NW";
  }

  return null;
}

function buildSlotPlacements(state) {
  return Object.fromEntries(
    Object.entries(state.slots).map(([slotId, slotState]) => [slotId, slotState.placedMask])
  );
}

function resolveRoute(nextState, routeId) {
  const route = getRoute(nextState.board, routeId);
  const routeState = nextState.routes[routeId];
  const routeSlots = getRouteSlots(nextState.board, routeId);

  routeState.completed = true;
  nextState.terminals[route.terminalId].completed = true;

  for (const slot of routeSlots) {
    nextState.slots[slot.slotId].locked = true;
  }

  if (route.terminalType === "damage") {
    nextState.scores[route.owner] += 1;
  }

  return {
    routeId,
    owner: route.owner,
    terminalId: route.terminalId,
    terminalType: route.terminalType,
    score: nextState.scores[route.owner]
  };
}

export function createAuthoritativeMatchState(board, {
  matchId = "circuit-siege-local",
  initialScores = null
} = {}) {
  const blueScore = Number(initialScores?.blue);
  const redScore = Number(initialScores?.red);
  const state = {
    matchId,
    board,
    phase: "live",
    scores: {
      blue: Number.isFinite(blueScore) ? Math.max(0, Math.floor(blueScore)) : 0,
      red: Number.isFinite(redScore) ? Math.max(0, Math.floor(redScore)) : 0
    },
    routes: {},
    terminals: {},
    slots: {}
  };

  for (const route of board.routes) {
    state.routes[route.routeId] = {
      completed: false,
      owner: route.owner,
      terminalType: route.terminalType
    };

    state.terminals[route.terminalId] = {
      completed: false,
      owner: route.owner,
      terminalType: route.terminalType
    };
  }

  for (const slot of board.repairSlots) {
    state.slots[slot.slotId] = buildInitialSlotState(slot);
  }

  return state;
}

export function applyPlayerIntent(state, intent) {
  const slotData = state.board.slotsById[intent?.slotId];
  if (!slotData) {
    return { ok: false, errorCode: "INVALID_SLOT", state, resolvedRoute: null };
  }

  const slotState = state.slots[slotData.slotId];
  if (!slotState) {
    return { ok: false, errorCode: "INVALID_SLOT_STATE", state, resolvedRoute: null };
  }

  if (slotData.owner !== intent.playerSide) {
    return { ok: false, errorCode: "WRONG_OWNER", state, resolvedRoute: null };
  }

  if (slotState.locked) {
    return { ok: false, errorCode: "SLOT_LOCKED", state, resolvedRoute: null };
  }

  let nextMask = null;

  if (intent.intentType === "PLACE_TILE") {
    if (slotData.slotType !== "hole") {
      return { ok: false, errorCode: "PLACE_REQUIRES_HOLE", state, resolvedRoute: null };
    }
    nextMask = pieceMaskFromIntent(intent.pieceType, intent.rotation);
  } else if (intent.intentType === "REPLACE_TILE") {
    if (slotData.slotType !== "refactor") {
      return { ok: false, errorCode: "REPLACE_REQUIRES_REFACTOR", state, resolvedRoute: null };
    }
    nextMask = pieceMaskFromIntent(intent.pieceType, intent.rotation);
  } else if (intent.intentType === "ROTATE_TILE") {
    if (!slotState.placedMask) {
      return { ok: false, errorCode: "ROTATE_REQUIRES_TILE", state, resolvedRoute: null };
    }
    nextMask = ROTATE_MASK[slotState.placedMask] || null;
  } else {
    return { ok: false, errorCode: "UNKNOWN_INTENT", state, resolvedRoute: null };
  }

  if (!nextMask) {
    return { ok: false, errorCode: "INVALID_PIECE", state, resolvedRoute: null };
  }

  const nextState = cloneState(state);
  nextState.slots[slotData.slotId].placedMask = nextMask;

  const routeState = nextState.routes[slotData.routeId];
  let resolvedRoute = null;

  if (!routeState.completed && isRouteComplete(nextState.board, slotData.routeId, buildSlotPlacements(nextState))) {
    resolvedRoute = resolveRoute(nextState, slotData.routeId);
  }

  return {
    ok: true,
    state: nextState,
    resolvedRoute,
    errorCode: null
  };
}
