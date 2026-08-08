// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/sim/grading.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

// Shift grading — pure.
//
// Three axes feed one grade:
//
//   1. Timing    — the rpm at the moment the clutch went in sets the ceiling.
//   2. Execution — how fast the gate was worked, and how cleanly, can only
//                  lower that ceiling.
//   3. The catch — picking the gas back up as the clutch bites, which can only
//                  lower it further.
//
// Stated as one rule: the grade is the rpm tier, dropped one step for a slow
// gate, one more for each wall bump, and one or two more for a mistimed catch.
// So bad timing plus a slow shift is a poor shift, perfect timing plus a slow
// shift is merely good, and a lightning gate can never rescue a badly timed one
// — timing is primary, exactly as the design intends.
//
// A snapped gate is rewarded with extra drive force rather than a better grade,
// which keeps the grade honest about timing while still paying for sharp hands.
// Landing in the wrong gear short-circuits everything and is simply `missed`.
//
// **The catch is why a shift is graded in two moments rather than one.** The
// gate resolving decides the gear and the clutch dead time — those happen now
// and cannot wait — but the last input that sets the grade has not been made
// yet. So `resolveShift` returns a *provisional* result and `finaliseShift`
// closes it once the gas is back on (or once it is clear it is not coming).

import {
  PERFECT_RPM_WINDOW,
  GOOD_RPM_WINDOW,
  GRADE_EFFECTS,
  SHIFT_SNAP_SECONDS,
  SHIFT_SLOW_SECONDS,
  SNAP_FORCE_BONUS,
  CATCH_CLEAN_SECONDS,
  CATCH_LOOSE_SECONDS,
} from "./constants.mjs";
import { SHIFT_COMPLETED, SHIFT_MISSED } from "./gate.mjs";

export const PERFECT = "perfect";
export const GOOD = "good";
export const POOR = "poor";
export const MISSED = "missed";

/** How the gas came back on. Not grades — they are steps off one. */
export const CATCH_CLEAN = "clean";
export const CATCH_LOOSE = "loose";
export const CATCH_FUMBLED = "fumbled";

const CATCH_PENALTIES = { [CATCH_CLEAN]: 0, [CATCH_LOOSE]: 1, [CATCH_FUMBLED]: 2 };

// Ordered best to worst. Downgrades walk this list but stop before `missed`,
// which is reserved for actually putting the car in the wrong gear.
const DOWNGRADE_LADDER = [PERFECT, GOOD, POOR];

/** Base grade from the rpm at the moment the clutch went in. */
export function gradeForRpm(car, rpm) {
  const delta = Math.abs(rpm - car.optimalShiftRpm);
  if (delta <= PERFECT_RPM_WINDOW) {
    return PERFECT;
  }
  if (delta <= GOOD_RPM_WINDOW) {
    return GOOD;
  }
  return POOR;
}

/** Steps a grade down the ladder, flooring at `poor`. `missed` is immovable. */
export function downgrade(grade, steps) {
  if (grade === MISSED) {
    return MISSED;
  }
  const index = DOWNGRADE_LADDER.indexOf(grade);
  if (index === -1) {
    throw new Error(`Unknown grade "${grade}"`);
  }
  const next = Math.min(DOWNGRADE_LADDER.length - 1, index + Math.max(0, steps));
  return DOWNGRADE_LADDER[next];
}

/** The car-behaviour payload for a grade. Throws on an unknown grade. */
export function effectsFor(grade) {
  const effects = GRADE_EFFECTS[grade];
  if (!effects) {
    throw new Error(`No grade effects defined for "${grade}"`);
  }
  return effects;
}

/** True when the gate was worked fast enough to earn the force bonus. */
export function isSnapShift(durationSeconds) {
  return durationSeconds <= SHIFT_SNAP_SECONDS;
}

/** Grade steps lost to a gate that dragged on. Slow hands cost exactly one. */
export function executionPenaltySteps(durationSeconds) {
  return durationSeconds > SHIFT_SLOW_SECONDS ? 1 : 0;
}

/**
 * Whether the timing was early or late, for feedback only. Deliberately not a
 * grade: `early` and `late` describe the same `poor` outcome from either side,
 * and promoting them to grades would imply they cost different amounts.
 */
export function timingReason(car, rpm) {
  if (Math.abs(rpm - car.optimalShiftRpm) <= PERFECT_RPM_WINDOW) {
    return null;
  }
  return rpm < car.optimalShiftRpm ? "early" : "late";
}

/**
 * How well the gas came back on, from its offset against the moment the clutch
 * bit. Negative is early — back on the throttle while the clutch is still out,
 * which does nothing but noise — and positive is late, which is dead time.
 *
 * `null` means the gas never came back at all, which is a fumble by definition
 * rather than an infinitely late catch: there is no offset to measure.
 */
export function gradeCatch(deltaSeconds) {
  if (deltaSeconds === null || deltaSeconds === undefined) {
    return CATCH_FUMBLED;
  }
  const offset = Math.abs(deltaSeconds);
  if (offset <= CATCH_CLEAN_SECONDS) {
    return CATCH_CLEAN;
  }
  return offset <= CATCH_LOOSE_SECONDS ? CATCH_LOOSE : CATCH_FUMBLED;
}

/** Grade steps lost to the catch. Clean costs nothing; a fumble costs two. */
export function catchPenaltySteps(catchGrade) {
  const steps = CATCH_PENALTIES[catchGrade];
  if (steps === undefined) {
    throw new Error(`Unknown catch grade "${catchGrade}"`);
  }
  return steps;
}

/**
 * Which side of the clutch the gas landed on, for feedback only — the same role
 * `timingReason` plays for the rpm, and deliberately not a grade for the same
 * reason: early and late cost the player exactly the same.
 */
export function catchReason(deltaSeconds) {
  if (deltaSeconds === null || deltaSeconds === undefined) {
    return "never";
  }
  if (Math.abs(deltaSeconds) <= CATCH_CLEAN_SECONDS) {
    return null;
  }
  return deltaSeconds < 0 ? "early" : "late";
}

/**
 * Combines timing and execution into a *provisional* grade, the gear the car
 * actually ends up in, and the clutch dead time the race loop must apply now.
 *
 * Provisional because the catch has not happened yet — see the note at the top
 * of the file. The dead time is final, though: it is what working the gate cost,
 * and it starts burning the instant the knob lands.
 *
 * `attempt` must already be resolved — grading a shift still in progress is a
 * caller bug, not a recoverable state.
 */
export function resolveShift({ car, rpmAtEngage, attempt, durationSeconds = 0 }) {
  if (attempt.status !== SHIFT_COMPLETED && attempt.status !== SHIFT_MISSED) {
    throw new Error("Cannot grade a shift that has not resolved");
  }

  const missed = attempt.status === SHIFT_MISSED;
  const penalty = executionPenaltySteps(durationSeconds) + attempt.gateErrors;
  const grade = missed ? MISSED : downgrade(gradeForRpm(car, rpmAtEngage), penalty);
  const snap = !missed && isSnapShift(durationSeconds);

  const base = effectsFor(grade);
  const effects = snap
    ? { ...base, forceMultiplier: base.forceMultiplier + SNAP_FORCE_BONUS }
    : base;

  return {
    grade,
    reason: missed ? null : timingReason(car, rpmAtEngage),
    snap,
    gear: attempt.landedGear,
    gateErrors: attempt.gateErrors,
    rpmAtEngage,
    durationSeconds,
    // Null until the catch closes it. A shift carrying a catch is finished.
    catch: null,
    effects,
  };
}

/**
 * Closes a provisional shift with the catch, producing the grade the player is
 * actually shown and the force multiplier they actually get.
 *
 * A fumble forfeits any *bonus* rather than zeroing the multiplier outright:
 * `GRADE_EFFECTS` uses the same field to punish a bad shift, and wiping it would
 * make fumbling a poor shift better than catching one.
 */
export function finaliseShift(result, deltaSeconds) {
  if (result.catch) {
    throw new Error("Shift has already been finalised");
  }

  const catchGrade = gradeCatch(deltaSeconds);
  const grade = downgrade(result.grade, catchPenaltySteps(catchGrade));
  const fumbled = catchGrade === CATCH_FUMBLED;
  const base = effectsFor(grade);
  const bonus = result.snap && !fumbled ? SNAP_FORCE_BONUS : 0;

  return {
    ...result,
    grade,
    catch: {
      grade: catchGrade,
      reason: catchReason(deltaSeconds),
      deltaSeconds: deltaSeconds ?? null,
    },
    effects: {
      ...base,
      forceMultiplier: fumbled
        ? Math.min(1, base.forceMultiplier)
        : base.forceMultiplier + bonus,
      // Already spent while the gate was being worked; carried so a finished
      // shift still reports what the whole manoeuvre cost.
      clutchSeconds: result.effects.clutchSeconds,
    },
  };
}
