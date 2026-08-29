// Aiming at a HORSE target: a placed bin, or a placed hoop.
//
// TWO GESTURES, AND WHICH ONE IS LIVE IS DECIDED BY THE TARGET RATHER THAN BY A
// SETTING. That reads at first like the surprise the Trick Shot Lab deliberately
// refused — a pull that changes meaning because of a picker two panels away —
// but the two cases are not the same one. The Lab's target is a detail of a
// layout the player is building and the ball usually goes into a cannon rather
// than at the target at all, so one gesture across both kinds is the honest
// answer there. A HORSE target is the WHOLE SHOT, chosen on the screen before
// this one, named in the status line, and drawn in the middle of the court. And
// the two targets ask genuinely different questions:
//
//   A BIN IS A HOLE IN THE FLOOR at a depth the player chose, so strength picks
//   how far down the room the ball lands and angle picks the lane. That is the
//   gesture Floor Tic-Tac-Toe already teaches, because it is the same act.
//
//   A HOOP IS ON THE WALL at the one depth there is, so there is no depth to
//   choose and strength has nothing to spend itself on but power. That is the
//   cabinet's own classic gesture, unchanged — the same one the timed run, the
//   How-to-Play court and the Lab all use.
//
// Neither has a selected-target state and neither snaps. Whichever real mouth
// the ball physically drops through is the one that counts, and here there is
// only ever one of those.
//
// THE AIM HEIGHT IS THE TARGET'S OWN HEIGHT, AND THAT IS NOT AIM ASSIST.
// Tic-Tac-Toe solves its shots to arrive at `BIN_MOUTH_Y`, which is the height
// of every bin on its board — the solver has always been told how high the
// target is, and only depth and lane were ever the player's problem. A HORSE bin
// can stand anywhere, so "how high the target is" is a number rather than a
// constant, and nothing else changes. Take it away and the player would be
// inverting a ballistic arc in their head to work out how much deeper than a
// raised bin they have to aim, which is arithmetic rather than a skill.
//
// The hoop half of that is the more surprising one, and it is the same rule.
// `sim/pull.js` returns an `aimY` pinned to `HOOP_BASE_RIM_Y` — the reticle has
// always ridden one fixed line, because until now the rim only ever hung on one
// peg. A hoop the setter has raised or dropped makes that line wrong, and a
// player left to correct for it by hand would be inverting a ballistic arc in
// their head to work out how much harder to pull at a higher rim. So the aim
// line follows the placed hoop, and `pull.aimY` is deliberately not read.
//
// IT IS THE TARGET'S REST HEIGHT, NOT ITS LIVE ONE. A moving target is not
// tracked, exactly as the classic cabinet's reticle never tracks the moving rim:
// leading it is the skill the motion modes exist to ask for, so the shot is
// always solved against where the target was PLACED.

import { AIM_RIM_Y_OFFSET, REFERENCE_POWER, RIM_CENTER_Z } from "./constants.js";
import { PLACEMENT_BOUNDS, binMotionById, normalizeBinSetup } from "./bin-placement.js";
import { hoopModeById } from "./hoop.js";
import { normalizeHoopSetup, placedHoopAt } from "./hoop-placement.js";
import { binEntryVelocity, solveLaunch } from "./launch.js";
import { projectPoint } from "./projection.js";
import { BIN_TARGET, HOOP_TARGET, trickShotTargetAt } from "./trick-shot-target.js";

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
 * Which kind of target a HORSE setup describes.
 *
 * ANYTHING THAT IS NOT EXPLICITLY A HOOP IS A BIN, and this is the one place
 * that is said. It is deliberately NOT `trickShotTargetKind`, whose default is
 * the hoop because the Trick Shot Lab opens on one. A HORSE setup written before
 * HORSE had targets carries no `kind` at all, and every one of those was a bin —
 * an online match in flight or a standing shot held across a deploy must not
 * have its target change underneath it.
 *
 * Both halves of a ruling read it: the solve below, and `horseTargetAt` for the
 * colliders. Split across two files they could disagree about a kindless setup,
 * and the shot would be solved at a bin while being stepped against a hoop.
 */
export function horseTargetKind(setup) {
  return setup?.kind === HOOP_TARGET ? HOOP_TARGET : BIN_TARGET;
}

/**
 * How long this target's path takes to come back to itself.
 *
 * The two catalogs are kept apart on purpose — one is authored in screen space
 * and one in world space — so this dispatches rather than merging them, exactly
 * as `horseTargetAt` does. It is here so that "the same moment of the same
 * sweep" is a thing a caller can ASK FOR: a phase and that phase plus a whole
 * period put the target in the identical place, which is what lets a shot be
 * repeated without waiting out however long the setter stood there watching.
 */
export function horseMotionPeriod(setup) {
  const motion = horseTargetKind(setup) === HOOP_TARGET
    ? hoopModeById(setup?.motionId)
    : binMotionById(setup?.motionId);
  const period = Number(motion?.period);
  return Number.isFinite(period) && period > 0 ? period : 1;
}

/** The HORSE target at a moment on the turn's motion clock. */
export function horseTargetAt(setup, elapsedSeconds = 0) {
  return trickShotTargetAt({ ...setup, kind: horseTargetKind(setup) }, elapsedSeconds);
}

/**
 * Solve a HORSE shot.
 *
 * `setup` is the target the shot is aimed at, and one call answers for both
 * kinds so a caller — including `factory-network-server`'s adjudicator, which
 * has to rule on whatever the setter chose — never branches on the kind itself.
 * The kind comes from `horseTargetKind` above, which is also what resolves the
 * target the colliders will see.
 */
export function createHorseShot(pull, origin, setup, { weight = 1 } = {}) {
  return horseTargetKind(setup) === HOOP_TARGET
    ? createHorseHoopShot(pull, origin, setup, { weight })
    : createHorseBinShot(pull, origin, setup, { weight });
}

/**
 * The wall hoop: the cabinet's classic solve, aimed at the rim's own rest line.
 *
 * `targetZ` is left to `solveLaunch`'s own default of `RIM_CENTER_Z` — stated
 * here anyway because it is the whole reason strength is free to be power: there
 * is exactly one depth a hoop can be at, so nothing else needs it.
 */
function createHorseHoopShot(pull, origin, setup, { weight = 1 } = {}) {
  const rest = placedHoopAt(normalizeHoopSetup(setup), 0);
  const aim = { x: pull.aimX, y: rest.rimY + AIM_RIM_Y_OFFSET };
  const launch = solveLaunch({
    origin,
    aim,
    targetZ: RIM_CENTER_Z,
    power: pull.power,
    loft: pull.loft,
    weight,
  });
  launch.inputPower = clamp(pull.power, 0, 1);
  return { launch, aim, targetZ: RIM_CENTER_Z };
}

/**
 * A placed bin — read only for its REST mouth height, never for its depth or
 * its lane, which are the two things the player is being asked for.
 */
function createHorseBinShot(pull, origin, setup, { weight = 1 } = {}) {
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
    entryVelocity: binEntryVelocity(weight),
    weight,
  });
  launch.inputPower = clamp(pull.power, 0, 1);
  return { launch, aim, targetZ };
}
