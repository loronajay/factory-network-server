// Server-authoritative HORSE.
//
// The classic cabinet's online mode is a race against a clock; HORSE is a
// conversation. One player arranges a bin and shoots at it, the other owes that
// exact shot, and a miss costs a letter. So the state this engine owns is not a
// score — it is WHOSE TURN IT IS, WHAT THEY OWE, and HOW MUCH OF THE WORD THEY
// HAVE SPELLED.
//
// TWO THINGS ARE AUTHORITATIVE HERE AND NEITHER IS OPTIONAL.
//
// The PLACEMENT: it arrives mid-match rather than as lobby config, and it is
// re-clamped through the cabinet's own `normalizeBinSetup` before anybody
// shoots at it. A client that invented a bin outside the legal volume would be
// handing its opponent a shot the rules never allow, and the opponent's own
// copy of the sim would then disagree about where the bin even is.
//
// The OUTCOME: the browser sends a pull, never a result. `horse-adjudicator.mjs`
// replays it through a mirrored copy of the cabinet's sim, and this file asks
// `sim/horse.js` — the same rules file both clients import — what that means.
import { normalizeBinSetup } from "../shared/scripts/sim/bin-placement.js";
import {
  PHASE_MATCH,
  createHorseMatch,
  normalizeWord,
  resolveHorseShot,
  shotSetupFor,
} from "../shared/scripts/sim/horse.js";
import { AIM_MAX_X, AIM_MIN_X } from "../shared/scripts/sim/constants.js";
import { adjudicateHorseShot } from "./horse-adjudicator.mjs";

export const HORSE_GAME_ID = "mini-hoops-horse";
export const HORSE_PROTOCOL_VERSION = 1;
export const HORSE_RECONNECT_GRACE_MS = 30_000;

// A SANITY BOUND, NOT A GAME RULE. The release moment has to be taken from the
// client — every phase of a bin's sweep is legitimately reachable, because a
// player may watch it for as long as they like — so this only exists to keep a
// nonsense value bounded. It is deliberately far past any real turn: clamping a
// number a player actually released on would rule on a phase they never saw.
const MAX_MOTION_SECONDS = 3600;

function clean(value, max, fallback = "") {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, max);
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function normalizeHorseConfig(settings = {}) {
  return { word: normalizeWord(settings.word), protocolVersion: HORSE_PROTOCOL_VERSION };
}

/**
 * A pull, and the phase of the bin's motion the player released on.
 *
 * `aimY` is deliberately absent, which is the one difference from the classic
 * cabinet's shot. There the reticle rides a single fixed line and the server
 * pins it; here the validated placement's own rest height IS the vertical aim,
 * so there is nothing left for a crafted client to raise.
 *
 * THE MOTION CLOCK IS THE CLIENT'S TO CHOOSE, and that is not a hole. A player
 * may watch a moving bin for as long as they like before releasing, so every
 * phase of the path is legitimately reachable — picking the moment is the skill
 * the motions exist to ask for.
 */
export function sanitizeHorseShot(value = {}) {
  return {
    power: clamp(value.power, 0, 1, 0),
    aimX: clamp(value.aimX, AIM_MIN_X, AIM_MAX_X, (AIM_MIN_X + AIM_MAX_X) / 2),
    loft: clamp(value.loft, 0, 1, 1),
    motionSeconds: clamp(value.motionSeconds, 0, MAX_MOTION_SECONDS, 0),
    expectedShots: Math.max(0, Math.floor(clamp(value.expectedShots, 0, 10_000, 0))),
  };
}

/** A placement, put through the cabinet's own legal-volume clamp. */
export function sanitizeHorsePlacement(value = {}) {
  return normalizeBinSetup({
    x: Number(value.x) || 0,
    y: Number(value.y) || 0,
    z: Number(value.z) || 0,
    motionId: typeof value.motionId === "string" ? value.motionId : "still",
  });
}

function playerFromLobby(lobby, clientId, index) {
  const profile = lobby?.memberProfiles?.get(clientId) || {};
  return {
    id: clientId,
    accountPlayerId: clean(profile.playerId, 64),
    name: clean(profile.displayName, 24, `Player ${index + 1}`),
    connected: true,
  };
}

export function createHorseMatchState(lobby, startAt) {
  const config = normalizeHorseConfig(lobby?.settings);
  const seats = [...(lobby?.members || [])].map((clientId, index) => playerFromLobby(lobby, clientId, index));
  const match = createHorseMatch({
    mode: "online",
    word: config.word,
    names: seats.map(({ name }) => name),
  });
  // The rules file owns a player row of its own (a name and a letter count).
  // The lobby's row carries identity. They sit side by side rather than being
  // merged, so `sim/horse.js` stays the pure module both clients already run.
  for (const [index, seat] of seats.entries()) {
    if (!match.players[index]) continue;
    match.players[index].id = seat.id;
    match.players[index].accountPlayerId = seat.accountPlayerId;
    match.players[index].connected = true;
  }
  return {
    gameId: HORSE_GAME_ID,
    roomCode: clean(lobby?.roomCode, 8),
    authorityMode: "server",
    phase: "live",
    startAt: Number(startAt) || Date.now(),
    config,
    seats,
    match,
    // The bin the current setter has arranged but not yet shot at. Not part of
    // the rules — `sim/horse.js` only learns about a bin when a shot lands on
    // one — but it has to be replicated, or the opponent watches a shot at a
    // bin they cannot see.
    pendingSetup: null,
    sequence: 0,
    lastShot: null,
    endedReason: "",
  };
}

function seatIndex(state, clientId) {
  return state.seats.findIndex((seat) => seat.id === clientId);
}

function isLive(state) {
  return Boolean(state)
    && state.phase !== "complete"
    && state.phase !== "paused"
    && state.match.status === "playing";
}

export function applyHorsePlacement(state, clientId, rawSetup) {
  if (!isLive(state)) return state;
  const seat = seatIndex(state, clientId);
  if (seat < 0 || seat !== state.match.turn) return state;
  // A matcher owes the standing shot exactly. Letting them place would let them
  // answer a shot with a different one.
  if (state.match.phase === PHASE_MATCH) return state;
  const next = structuredClone(state);
  next.pendingSetup = sanitizeHorsePlacement(rawSetup);
  return next;
}

export function applyHorseShot(state, clientId, rawIntent, now = Date.now(), adjudicate = adjudicateHorseShot) {
  if (!isLive(state)) return state;
  const seat = seatIndex(state, clientId);
  if (seat < 0 || seat !== state.match.turn || state.seats[seat].connected === false) return state;
  const intent = sanitizeHorseShot(rawIntent);
  // The duplicate guard: a resent shot names a shot number that has already
  // been spent, and is dropped rather than fired twice.
  if (intent.expectedShots !== state.match.shots) return state;

  // A setter shoots at what they placed; a matcher at what stands. The rules
  // file answers that, so this one never has to know which is which.
  const setup = shotSetupFor(state.match, state.pendingSetup);
  if (!setup) return state;

  const ruling = adjudicate({ intent, setup, motionSeconds: intent.motionSeconds }) || {};
  const made = ruling.made === true;

  const next = structuredClone(state);
  const outcome = resolveHorseShot(next.match, made, setup);
  next.pendingSetup = null;
  next.sequence += 1;
  next.lastShot = {
    sequence: next.sequence,
    shooterId: clientId,
    seat,
    serverAt: now,
    intent,
    setup,
    made,
    kind: outcome.kind || "",
    letter: outcome.letter === true,
    contacts: Array.isArray(ruling.contacts) ? ruling.contacts.slice(0, 16).map(String) : [],
  };
  if (next.match.status !== "playing") {
    next.phase = "complete";
    next.endedReason = "word";
  }
  return next;
}

export function applyHorseDisconnect(state, clientId) {
  if (!state || state.phase === "complete") return state;
  const seat = seatIndex(state, clientId);
  if (seat < 0) return state;
  const next = structuredClone(state);
  if (next.seats[seat].connected === false) {
    // Gone once already and the grace period is spent: the match is over, and
    // the player still standing at the court keeps it.
    next.phase = "complete";
    next.endedReason = "forfeit";
    next.match.status = "won";
    next.match.winner = seat === 0 ? 1 : 0;
    return next;
  }
  next.seats[seat].connected = false;
  if (next.match.players[seat]) next.match.players[seat].connected = false;
  next.phase = "paused";
  return next;
}

export function applyHorseReconnect(state, clientId) {
  if (!state || state.phase === "complete") return state;
  const seat = seatIndex(state, clientId);
  if (seat < 0) return state;
  const next = structuredClone(state);
  next.seats[seat].connected = true;
  if (next.match.players[seat]) next.match.players[seat].connected = true;
  next.phase = next.seats.every(({ connected }) => connected !== false) ? "live" : "paused";
  return next;
}

export function finalizeHorseMatch(state, reason = "forfeit", winnerSeat = null) {
  if (!state || state.phase === "complete") return state;
  const next = structuredClone(state);
  next.phase = "complete";
  next.endedReason = reason;
  if (winnerSeat === 0 || winnerSeat === 1) {
    next.match.status = "won";
    next.match.winner = winnerSeat;
  }
  return next;
}

export function serializeHorseMatch(state, serverNow = Date.now()) {
  return {
    authorityMode: "server",
    gameId: HORSE_GAME_ID,
    roomCode: state.roomCode,
    protocolVersion: HORSE_PROTOCOL_VERSION,
    serverNow,
    startAt: state.startAt,
    phase: state.phase,
    config: { ...state.config },
    seats: state.seats.map((seat) => ({ ...seat })),
    match: structuredClone(state.match),
    pendingSetup: state.pendingSetup ? { ...state.pendingSetup } : null,
    sequence: state.sequence,
    lastShot: state.lastShot ? structuredClone(state.lastShot) : null,
    result: state.phase === "complete"
      ? { winnerSeat: state.match.winner, reason: state.endedReason }
      : null,
  };
}
