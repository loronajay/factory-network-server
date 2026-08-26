// Aiming at a placed bin.
//
// The gesture is the one Floor Tic-Tac-Toe already teaches, because it is the
// same act: one drag, where STRENGTH picks how far down the room the ball is
// thrown and ANGLE picks the lane. There is no selected-target state and no
// snapping — whichever real mouth the ball physically drops through is the one
// that counts, and here there is only one of those.
//
// THE AIM HEIGHT IS THE BIN'S OWN MOUTH HEIGHT, AND THAT IS NOT AIM ASSIST.
// Tic-Tac-Toe solves its shots to arrive at `BIN_MOUTH_Y`, which is the height
// of every bin on its board — the solver has always been told how high the
// target is, and only depth and lane were ever the player's problem. A HORSE bin
// can stand anywhere, so "how high the target is" is a number rather than a
// constant, and nothing else changes. Take it away and the player would be
// inverting a ballistic arc in their head to work out how much deeper than a
// raised bin they have to aim, which is arithmetic rather than a skill.
//
// IT IS THE BIN'S REST HEIGHT, NOT ITS LIVE ONE. A moving bin is not tracked,
// exactly as the classic cabinet's reticle never tracks the moving rim: leading
// the target is the skill the motion modes exist to ask for, so the shot is
// always solved against where the bin was PLACED.

import { REFERENCE_POWER } from "./constants.js";
import { PLACEMENT_BOUNDS, normalizeBinSetup } from "./bin-placement.js";
import { solveLaunch } from "./launch.js";
import { projectPoint } from "./projection.js";

// The steep arrival the bin modes shoot with — a ball dropping INTO a hole in
// the ground rather than arcing through a ring. Shared with tic-tac-toe's value
// on purpose: it is a property of the target being a bin.
const BIN_ENTRY_VELOCITY = -4;

// A little slack past the legal placement volume at both ends, so a bin sitting
// exactly on the front or back limit is not aimable only at 0% or 100% — the
// extremes of a pull are the hardest part of it to hold steady.
const DEPTH_MARGIN = 0.06;

export const HORSE_AIM_MIN_Z = PLACEMENT_BOUNDS.minZ - DEPTH_MARGIN;
export const HORSE_AIM_MAX_Z = PLACEMENT_BOUNDS.maxZ + DEPTH_MARGIN;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * How far down the room a given pull throws the ball.
 *
 * LINEAR ACROSS THE WHOLE LEGAL VOLUME, so the meter means one thing everywhere
 * and every bin a player is allowed to place is reachable somewhere on the dial.
 * Derived from the placement bounds rather than typed, which is what keeps this
 * honest in a room of any depth: make the room deeper and the same pull still
 * spans exactly the placeable range.
 */
export function horseAimDepth(power) {
  return HORSE_AIM_MIN_Z + clamp(power, 0, 1) * (HORSE_AIM_MAX_Z - HORSE_AIM_MIN_Z);
}

/** The inverse — the pull that lands at a given depth. Used by the CPU and the practice hints. */
export function horsePowerForDepth(z) {
  const span = HORSE_AIM_MAX_Z - HORSE_AIM_MIN_Z;
  return span <= 0 ? 0 : clamp((z - HORSE_AIM_MIN_Z) / span, 0, 1);
}

/**
 * Solve a HORSE shot.
 *
 * `setup` is the bin the shot is aimed at — read only for its REST mouth height,
 * never for its depth or its lane, which are the two things the player is being
 * asked for.
 */
export function createHorseShot(pull, origin, setup, { weight = 1 } = {}) {
  const rest = normalizeBinSetup(setup);
  const targetZ = horseAimDepth(pull.power);
  const aim = {
    x: pull.aimX,
    y: projectPoint({ x: 0, y: rest.y, z: targetZ }).y,
  };
  const launch = solveLaunch({
    origin,
    aim,
    targetZ,
    // Strength has already chosen the depth, so the launch itself is solved at
    // the calibrated reference: the near end of the room must not demand a
    // limp pull that would also be an unreadable meter.
    power: REFERENCE_POWER,
    loft: pull.loft,
    entryVelocity: BIN_ENTRY_VELOCITY,
    weight,
  });
  launch.inputPower = clamp(pull.power, 0, 1);
  return { launch, aim, targetZ };
}
