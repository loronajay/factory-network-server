// Where the cue ball is allowed to be put down.
//
// Pure. The single owner of the house rule, so the pointer handler, the CPU and
// the rendered kitchen overlay cannot disagree about it — in the demo the first
// two each carried their own copy of the test.
//
// THE HOUSE RULE: a scratch is cue ball in hand BEHIND THE HEAD STRING; any
// other foul is ball in hand anywhere. The ball may touch the string but not
// cross it, which is why the comparison below is strict.

import { BALL_RADIUS, BREAK_CUE_X, HALF_LENGTH, HALF_WIDTH, HEAD_STRING_X } from "./constants.js";
import { CUE } from "./balls.js";

/** @typedef {"none"|"kitchen"|"anywhere"} BallInHandZone */

export const ZONE_NONE = "none";
export const ZONE_KITCHEN = "kitchen";
export const ZONE_ANYWHERE = "anywhere";

/**
 * Is this a legal place to set the cue ball down?
 *
 * Three tests, in the order a player would apply them: on the cloth with a
 * little margin off the rails, inside the zone the foul granted, and not
 * touching another ball.
 */
export function isLegalCuePosition(balls, x, z, zone = ZONE_ANYWHERE) {
  if (Math.abs(x) > HALF_LENGTH - BALL_RADIUS * 1.35) return false;
  if (Math.abs(z) > HALF_WIDTH - BALL_RADIUS * 1.35) return false;
  if (zone === ZONE_KITCHEN && x > HEAD_STRING_X) return false;

  for (const ball of balls) {
    if (ball.n === CUE || ball.pocketed) continue;
    if (Math.hypot(x - ball.x, z - ball.z) < 2.08 * BALL_RADIUS) return false;
  }

  return true;
}

/** Margin off the rails a placed ball keeps, and the gap it keeps off its neighbours. */
const RAIL_MARGIN = BALL_RADIUS * 1.35;
const BALL_GAP = 2.08 * BALL_RADIUS;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/**
 * The legal spot the player is ASKING for, dragged rather than chosen.
 *
 * This is the difference between placement that feels like moving a ball and
 * placement that feels like a form rejecting a field. `isLegalCuePosition` is a
 * yes/no, and a drag handler that only accepts a yes leaves the ball frozen at
 * the last legal pixel while the pointer walks away, then teleports it back when
 * the pointer happens to re-enter — which reads as snapping, because it is.
 *
 * So the pointer is never refused: it is CLAMPED. Off the end of the cloth the
 * ball slides along the rail; past the head string it slides along the string;
 * into another ball it slides around the outside of it. Every one of those is
 * the ball following the finger, which is the only thing the player asked for.
 *
 * Resolved in passes because the three constraints fight: sliding off one ball
 * can push into the next or into a rail. Eight is far more than a table ever
 * needs, and the fallback is the spiral search, so this still cannot return an
 * illegal answer.
 */
export function clampCuePosition(balls, x, z, zone = ZONE_ANYWHERE) {
  const limit = (px, pz) => {
    const nx = zone === ZONE_KITCHEN ? Math.min(px, HEAD_STRING_X) : px;
    return {
      x: clamp(nx, -(HALF_LENGTH - RAIL_MARGIN), HALF_LENGTH - RAIL_MARGIN),
      z: clamp(pz, -(HALF_WIDTH - RAIL_MARGIN), HALF_WIDTH - RAIL_MARGIN),
    };
  };

  let point = limit(x, z);
  for (let pass = 0; pass < 8; pass++) {
    let pushed = false;
    for (const ball of balls) {
      if (ball.n === CUE || ball.pocketed) continue;
      const dx = point.x - ball.x;
      const dz = point.z - ball.z;
      const distance = Math.hypot(dx, dz);
      if (distance >= BALL_GAP) continue;
      pushed = true;
      // A hair past touching, because `isLegalCuePosition` compares strictly and
      // a push to exactly the gap can land a float below it.
      const reach = BALL_GAP * 1.0002;
      // Dead centre has no direction to slide in; any one will do.
      const ux = distance > 1e-6 ? dx / distance : 1;
      const uz = distance > 1e-6 ? dz / distance : 0;
      point = { x: ball.x + ux * reach, z: ball.z + uz * reach };
    }
    point = limit(point.x, point.z);
    if (!pushed) break;
  }

  if (isLegalCuePosition(balls, point.x, point.z, zone)) return point;
  return findLegalCuePosition(balls, point.x, point.z, zone);
}

/**
 * The nearest legal spot to where the caller wanted the cue ball.
 *
 * Spiral outward in rings rather than giving up, because "there is nowhere to
 * put the ball" is not an outcome 8-ball has: a cluster over the head spot must
 * still resolve to somewhere. The final fallback is the break spot, which on a
 * table with fifteen balls on it is very nearly always clear.
 *
 * @returns `{ x, z }` — always. Never null.
 */
export function findLegalCuePosition(balls, preferredX = BREAK_CUE_X, preferredZ = 0, zone = ZONE_ANYWHERE) {
  if (isLegalCuePosition(balls, preferredX, preferredZ, zone)) return { x: preferredX, z: preferredZ };

  const SAMPLES = 24;
  for (let ring = 0; ring < 12; ring++) {
    const radius = 0.06 + ring * 0.055;
    for (let i = 0; i < SAMPLES; i++) {
      const around = (i / SAMPLES) * Math.PI * 2;
      const x = preferredX + Math.cos(around) * radius;
      const z = preferredZ + Math.sin(around) * radius;
      if (isLegalCuePosition(balls, x, z, zone)) return { x, z };
    }
  }

  return { x: BREAK_CUE_X, z: 0 };
}

/** Where a given foul wants the cue ball spotted before the player moves it. */
export function defaultSpotFor(zone) {
  return zone === ZONE_KITCHEN ? { x: -0.82, z: 0 } : { x: -0.52, z: 0 };
}
