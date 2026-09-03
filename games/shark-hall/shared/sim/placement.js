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
