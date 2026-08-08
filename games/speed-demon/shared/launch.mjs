// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/sim/launch.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

// Launch grading — pure.
//
// Reaction time is measured from the green bulb to the throttle, the way a drag
// strip measures it. There is a genuine reward window at the top: hitting the
// throttle within `LAUNCH_PERFECT_WINDOW` of green grants a holeshot boost, so
// the start line is a skill check rather than a formality.
//
// Touching the throttle before green is a foul. It is deliberately not a
// disqualification — see LAUNCH_EFFECTS in constants.js for why.

import { LAUNCH_PERFECT_WINDOW, LAUNCH_GOOD_WINDOW, LAUNCH_EFFECTS } from "./constants.mjs";

export const LAUNCH_HOLESHOT = "holeshot";
export const LAUNCH_GOOD = "good";
export const LAUNCH_LATE = "late";
export const LAUNCH_FOUL = "foul";

/**
 * Grades a launch from its reaction time in seconds.
 *
 * `falseStart` is latched by the race when the throttle is touched during the
 * countdown; a negative reaction time means the same thing arrived by a
 * different route, and both are fouls.
 */
export function gradeLaunch(reactionSeconds, { falseStart = false } = {}) {
  if (falseStart || reactionSeconds < 0) {
    return LAUNCH_FOUL;
  }
  if (reactionSeconds <= LAUNCH_PERFECT_WINDOW) {
    return LAUNCH_HOLESHOT;
  }
  if (reactionSeconds <= LAUNCH_GOOD_WINDOW) {
    return LAUNCH_GOOD;
  }
  return LAUNCH_LATE;
}

/** Force multiplier and duration the race applies off the line. */
export function launchEffectsFor(grade) {
  const effects = LAUNCH_EFFECTS[grade];
  if (!effects) {
    throw new Error(`No launch effects defined for "${grade}"`);
  }
  return effects;
}
