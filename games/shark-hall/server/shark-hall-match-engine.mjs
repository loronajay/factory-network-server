// Shark Hall online, as one authoritative match.
//
// The whole point of this file is that the SERVER plays the shot. A client sends
// four numbers — where the cue points, how hard it was held, and where the tip
// landed on the ball — and this module runs the cabinet's own physics over the
// table it is holding, asks the cabinet's own rules what happened, and publishes
// the result. A client never reports a pot, a foul, a group or a winner; those
// messages are refused outright by the adapter beside this one.
//
// It can do that because the cabinet's `scripts/sim/` is pure and deterministic
// — no THREE, no DOM, no clock, no ambient random — and `shared/sim/` here is a
// byte-for-byte copy of it, guarded by `mirror.test.mjs` against a manifest
// written in both repos. The cabinet was built that way on purpose; this is the
// file that cashes it in.
//
// DETERMINISM IS WHAT MAKES IT PLAYABLE, not just fair. The clients are not sent
// a path or a frame log: they are sent the table as it stood before the stroke
// and the stroke itself, and they run the identical simulation to ANIMATE it.
// One shot costs about sixty bytes on the wire no matter how long the balls
// roll. When their replay settles they snap to the authoritative table below,
// so a divergence is corrected rather than argued with.
//
// Pure. No sockets, no timers, no lobby: state in, state out. The adapter
// (`shark-hall-lobby-game.mjs`) owns every side effect.

import { cloneBalls, cueBall, groupOf, rackBalls, remaining } from "../shared/sim/balls.js";
import { ZONE_ANYWHERE, ZONE_KITCHEN, ZONE_NONE, defaultSpotFor, findLegalCuePosition } from "../shared/sim/placement.js";
import { resolveShot } from "../shared/sim/rules.js";
import { clampContact } from "../shared/sim/shot.js";
import { createWorld } from "../shared/sim/world.js";

export const SHARK_HALL_GAME_ID = "shark-hall";

/** Bumped whenever the wire shape changes. A lobby will not start unless both seats match. */
export const SHARK_HALL_PROTOCOL_VERSION = 1;

/**
 * How long a dropped player's seat is held.
 *
 * Generous on purpose. A rack is long, the table between shots is not urgent,
 * and a match lost to a dropped tab is the worst outcome this cabinet has.
 */
export const SHARK_HALL_RECONNECT_GRACE_MS = 45000;

/** The race lengths a host may pick. Anything else is coerced to the middle one. */
export const RACE_LENGTHS = Object.freeze([1, 3, 5]);
export const DEFAULT_RACE_TO = 3;

export const PHASE_AIMING = "aiming";
export const PHASE_PAUSED = "paused";
export const PHASE_COMPLETE = "complete";

/**
 * Simulated seconds per authoritative step, and the ceiling on them.
 *
 * A frame's worth, because that is what the browser feeds the same world: the
 * substeps inside `world.step` are a fixed 240hz drained from an accumulator, so
 * a server stepping evenly and a browser stepping raggedly walk the identical
 * substep sequence. The cap is sixty simulated seconds — far past any real shot,
 * and the difference between a stuck match and a stuck process.
 */
const STEP_SECONDS = 1 / 60;
const MAX_STEPS = 3600;

export function sanitizeRaceTo(value) {
  const numeric = Math.floor(Number(value));
  return RACE_LENGTHS.includes(numeric) ? numeric : DEFAULT_RACE_TO;
}

function text(value, max, fallback = "") {
  const clean = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (clean || fallback).slice(0, max);
}

function finite(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

/** Which seat breaks a given rack. Racks alternate; a rerack is the same rack again. */
export function breakerForRack(rackNumber) {
  return (Math.max(1, Math.floor(rackNumber)) - 1) % 2;
}

function freshRack(match, rackNumber) {
  const breaker = breakerForRack(rackNumber);
  return {
    ...match,
    rackNumber,
    breaker,
    shooter: breaker,
    groups: [null, null],
    isBreak: true,
    ballInHand: ZONE_NONE,
    balls: rackBalls(),
    rackWinner: null,
    phase: PHASE_AIMING,
    kicker: "Rack ready",
    message: rackNumber === 1 ? "Rack ready · break it." : "Rack " + rackNumber + " · fresh triangle.",
  };
}

/**
 * Open a match for a two-seat lobby.
 *
 * Seat order is the lobby's member order, which is the join order: the host
 * breaks the first rack. Every seat field the clients read is fixed here, so a
 * later message cannot change who is playing.
 */
export function createSharkMatchState(lobby, startAt = Date.now()) {
  const members = [...(lobby?.members || [])].slice(0, 2);
  const seats = members.map((clientId, index) => {
    const profile = lobby?.memberProfiles?.get(clientId) || {};
    return {
      clientId,
      playerId: text(profile.playerId, 64),
      name: text(profile.displayName, 18, "Player " + (index + 1)),
      wins: 0,
      connected: true,
      rematch: false,
    };
  });

  return freshRack({
    protocolVersion: SHARK_HALL_PROTOCOL_VERSION,
    raceTo: sanitizeRaceTo(lobby?.settings?.raceTo),
    seats,
    shotSeq: 0,
    startAt,
    matchWinner: null,
    pausedFrom: null,
  }, 1);
}

export function seatIndexOf(match, clientId) {
  const index = match?.seats?.findIndex((seat) => seat.clientId === clientId);
  return index === undefined ? -1 : index;
}

/**
 * Run one stroke to rest on the authoritative table.
 *
 * Exported because the tests replay it directly, and because it is the single
 * place the physics is entered from — there is no second path that moves a ball.
 */
export function playShot(balls, stroke) {
  const world = createWorld();
  world.load(balls);
  world.strike(stroke);
  let steps = 0;
  while (world.moving && steps < MAX_STEPS) {
    world.step(STEP_SECONDS);
    steps++;
  }
  return { balls: world.balls, report: world.report, steps };
}

function normalizeAngle(angle) {
  const turn = Math.PI * 2;
  const wrapped = angle % turn;
  if (wrapped > Math.PI) return wrapped - turn;
  if (wrapped <= -Math.PI) return wrapped + turn;
  return wrapped;
}

function sanitizeStroke(raw) {
  const contact = clampContact(raw?.spinX, raw?.spinY);
  return {
    // The angle arrives as a bare radian count and is wrapped rather than
    // clamped: every direction is a legal place to point a cue.
    angle: normalizeAngle(finite(raw?.angle, -1e6, 1e6, 0)),
    power: finite(raw?.power, 0, 1, 0.5),
    spinX: contact.spinX,
    spinY: contact.spinY,
  };
}

/**
 * Put the cue ball where the shooter asked, as near as the rules allow.
 *
 * A request outside the granted zone is pulled to the nearest legal spot rather
 * than refused. Refusing would be more literal and worse: the shooter is already
 * holding the ball, and an error at that moment leaves a turn that cannot be
 * taken. `findLegalCuePosition` never returns null, which is what makes this
 * total.
 */
function placeCueBall(balls, zone, request) {
  const spot = defaultSpotFor(zone);
  const wantedX = finite(request?.x, -10, 10, spot.x);
  const wantedZ = finite(request?.z, -10, 10, spot.z);
  const legal = findLegalCuePosition(balls, wantedX, wantedZ, zone);
  const next = cloneBalls(balls);
  const cue = cueBall(next);
  if (cue) {
    cue.pocketed = false;
    cue.x = legal.x;
    cue.z = legal.z;
    cue.vx = 0;
    cue.vz = 0;
    cue.wx = 0;
    cue.wy = 0;
    cue.wz = 0;
  }
  return next;
}

/**
 * Score a stroke and advance the match.
 *
 * @returns `{ match, shot, error }` — `shot` is what the clients replay, and is
 *   null whenever the request was refused.
 */
export function applySharkShot(match, clientId, request) {
  if (!match) return { match, shot: null, error: { code: "NO_MATCH", message: "There is no match running." } };
  if (match.phase === PHASE_COMPLETE) return { match, shot: null, error: { code: "MATCH_OVER", message: "The match is already decided." } };
  if (match.phase === PHASE_PAUSED) return { match, shot: null, error: { code: "MATCH_PAUSED", message: "Waiting for the other player to reconnect." } };

  const seat = seatIndexOf(match, clientId);
  if (seat < 0) return { match, shot: null, error: { code: "NOT_SEATED", message: "You are not at this table." } };
  if (seat !== match.shooter) return { match, shot: null, error: { code: "NOT_YOUR_TURN", message: "It is not your shot." } };

  // The sequence number is the whole of the replay guard. A shot is refused
  // unless the client is answering the table it was last shown, so a doubled
  // click, a late retry after a reconnect, or a resent frame cannot play the
  // same stroke twice on a table that has moved on.
  const expected = Math.floor(Number(request?.seq));
  if (Number.isFinite(expected) && expected !== match.shotSeq) {
    return { match, shot: null, error: { code: "STALE_SHOT", message: "That shot was aimed at an older table." } };
  }

  const stroke = sanitizeStroke(request);
  const before = match.ballInHand === ZONE_NONE
    ? cloneBalls(match.balls)
    : placeCueBall(match.balls, match.ballInHand, request?.place);

  const played = playShot(before, stroke);
  const outcome = resolveShot(
    played.balls,
    { shooter: seat, groups: match.groups, isBreak: match.isBreak },
    played.report,
  );

  const next = advance(match, seat, played, outcome);
  return {
    match: next,
    shot: {
      seq: match.shotSeq,
      seat,
      stroke,
      // The table BEFORE the stroke, so a client replays it from the same place
      // the server did. Cheaper than it looks — sixteen small objects — and it
      // doubles as the correction for any client that had drifted.
      ballsBefore: before,
      outcome,
      rackNumber: match.rackNumber,
    },
    error: null,
  };
}

function advance(match, seat, played, outcome) {
  const next = {
    ...match,
    shotSeq: match.shotSeq + 1,
    balls: cloneBalls(played.balls),
    kicker: outcome.kicker,
    message: outcome.reason,
  };

  if (outcome.rerack) {
    // The house rule: the 8 on the break is neither a win nor a loss. Same
    // breaker, fresh triangle, and the rack number does not move.
    return {
      ...freshRack(next, match.rackNumber),
      shotSeq: next.shotSeq,
      kicker: "Rerack",
      message: "8-ball on the break · rerack.",
    };
  }

  next.groups = outcome.groups;
  next.isBreak = false;

  // A scratched cue ball is back on the cloth before anyone can place it; the
  // zone the foul granted is what decides where it may end up.
  const cue = cueBall(next.balls);
  if (cue && cue.pocketed) cue.pocketed = false;

  if (outcome.winner !== null) return finishRack(next, outcome.winner, outcome);

  next.shooter = outcome.nextShooter;
  next.ballInHand = outcome.foul ? outcome.ballInHand : ZONE_NONE;
  if (next.ballInHand !== ZONE_NONE) {
    // Spot it somewhere legal immediately, so the incoming player is dragging a
    // ball that is already on the table rather than one that is nowhere.
    next.balls = placeCueBall(next.balls, next.ballInHand, defaultSpotFor(next.ballInHand));
  }
  return next;
}

function finishRack(match, winner, outcome) {
  const seats = match.seats.map((seat, index) => (index === winner ? { ...seat, wins: seat.wins + 1 } : seat));
  const decided = seats[winner].wins >= match.raceTo;
  const base = {
    ...match,
    seats,
    rackWinner: winner,
    shooter: winner,
    ballInHand: ZONE_NONE,
    kicker: outcome.kicker,
  };

  if (decided) {
    return {
      ...base,
      phase: PHASE_COMPLETE,
      matchWinner: winner,
      message: seats[winner].name + " wins the match " + seats[winner].wins + "-" + seats[1 - winner].wins + ".",
    };
  }

  // The next rack opens straight away rather than waiting on an acknowledgement:
  // the clients animate the closing shot from `ballsBefore` regardless, and a
  // race that stalls between racks is a race nobody finishes.
  return {
    ...freshRack(base, match.rackNumber + 1),
    seats,
    kicker: "Rack over",
    message: seats[winner].name + " takes rack " + match.rackNumber + " · " + seats[0].wins + "-" + seats[1].wins + ".",
  };
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export function applySharkDisconnect(match, clientId, now = Date.now()) {
  const seat = seatIndexOf(match, clientId);
  if (seat < 0 || match.phase === PHASE_COMPLETE) return match;

  // Second call for the same seat: the grace window is over, or the player left
  // outright. The rack, and the match, go to whoever is still standing.
  if (match.phase === PHASE_PAUSED && match.pausedFrom === clientId) {
    const winner = 1 - seat;
    const seats = match.seats.map((entry, index) => (index === winner ? { ...entry, wins: match.raceTo } : entry));
    return {
      ...match,
      seats,
      phase: PHASE_COMPLETE,
      matchWinner: winner,
      pausedFrom: null,
      kicker: "Opponent left",
      message: (match.seats[seat].name || "The opponent") + " left the table.",
    };
  }

  return {
    ...match,
    seats: match.seats.map((entry, index) => (index === seat ? { ...entry, connected: false } : entry)),
    phase: PHASE_PAUSED,
    pausedFrom: clientId,
    pausedAt: now,
    kicker: "Waiting",
    message: match.seats[seat].name + " dropped · holding the table.",
  };
}

export function applySharkReconnect(match, clientId, now = Date.now()) {
  const seat = seatIndexOf(match, clientId);
  if (seat < 0 || match.phase !== PHASE_PAUSED || match.pausedFrom !== clientId) return match;
  return {
    ...match,
    seats: match.seats.map((entry, index) => (index === seat ? { ...entry, connected: true } : entry)),
    phase: PHASE_AIMING,
    pausedFrom: null,
    pausedAt: null,
    resumedAt: now,
    kicker: "Back at the table",
    message: match.seats[seat].name + " is back · play on.",
  };
}

// ---------------------------------------------------------------------------
// Rematch
// ---------------------------------------------------------------------------

export function requestSharkRematch(match, clientId) {
  const seat = seatIndexOf(match, clientId);
  if (seat < 0 || match?.phase !== PHASE_COMPLETE) return { match, started: false };

  const seats = match.seats.map((entry, index) => (index === seat ? { ...entry, rematch: true } : entry));
  if (!seats.every((entry) => entry.rematch && entry.connected)) {
    return { match: { ...match, seats, message: seats[seat].name + " wants to run it back." }, started: false };
  }

  return {
    match: freshRack({
      ...match,
      seats: seats.map((entry) => ({ ...entry, wins: 0, rematch: false })),
      shotSeq: 0,
      matchWinner: null,
      pausedFrom: null,
    }, 1),
    started: true,
  };
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/** Everything a client draws, in one object. Never the live state. */
export function serializeSharkMatch(match, serverNow = Date.now()) {
  if (!match) return null;
  return {
    protocolVersion: match.protocolVersion,
    phase: match.phase,
    raceTo: match.raceTo,
    rackNumber: match.rackNumber,
    breaker: match.breaker,
    shooter: match.shooter,
    shooterId: match.seats[match.shooter] ? match.seats[match.shooter].clientId : "",
    groups: [...match.groups],
    isBreak: match.isBreak,
    ballInHand: match.ballInHand,
    balls: cloneBalls(match.balls),
    shotSeq: match.shotSeq,
    kicker: match.kicker,
    message: match.message,
    rackWinner: match.rackWinner,
    matchWinner: match.matchWinner,
    matchWinnerName: match.matchWinner === null ? null : match.seats[match.matchWinner].name,
    serverNow,
    seats: match.seats.map((seat, index) => ({
      clientId: seat.clientId,
      playerId: seat.playerId,
      name: seat.name,
      wins: seat.wins,
      connected: seat.connected,
      rematch: seat.rematch,
      group: match.groups[index],
      remaining: remaining(match.balls, match.groups[index]),
    })),
  };
}

export { ZONE_ANYWHERE, ZONE_KITCHEN, ZONE_NONE, groupOf };
