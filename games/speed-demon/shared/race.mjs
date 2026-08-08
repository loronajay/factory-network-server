// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/sim/race.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

// Race state machine — the composition root of the pure sim.
//
// Owns the phase transitions, the clock, and the wiring between the shifter gate,
// grading, and the engine. Still pure: no DOM, no canvas, no wall-clock reads.
// Every mutation goes through a function that returns a fresh race object, which
// is what makes a race replayable from a seed plus an input log — the property
// online play will be built on.

import { CATCH_LOOSE_SECONDS } from "./constants.mjs";
import { createCarState, stepCar } from "./engine.mjs";
import { beginShift, applyShiftInput, SHIFT_IN_GATE } from "./gate.mjs";
import { resolveShift, finaliseShift } from "./grading.mjs";
import { gradeLaunch, launchEffectsFor } from "./launch.mjs";

export const STAGING = "staging";
export const COUNTDOWN = "countdown";
export const RUNNING = "running";
export const FINISHED = "finished";

/** Highest gear the car's ratio table defines. */
export function topGear(car) {
  return Math.max(...Object.keys(car.gearRatios).map(Number));
}

/**
 * A race is measured against exactly one objective: a distance to cross, or a
 * clock to run out. Both, or neither, is a programming error rather than a
 * degraded race, so it throws — the objective decides when the run ends, and a
 * run with no end condition would simply never stop.
 *
 * `modes.js` produces this pair, so a new mode is a row in that catalog rather
 * than a branch in here.
 */
export function createRace({
  car,
  gate,
  distanceMetres = null,
  timeLimitSeconds = null,
  countdownSeconds = 3,
}) {
  if (!car || !gate) {
    throw new Error("A race needs both a car and a gate");
  }
  const hasDistance = distanceMetres !== null;
  const hasClock = timeLimitSeconds !== null;
  if (hasDistance === hasClock) {
    throw new Error("A race needs exactly one objective: a distance or a time limit");
  }
  if (hasDistance && !(distanceMetres > 0)) {
    throw new Error("A race needs a positive distance");
  }
  if (hasClock && !(timeLimitSeconds > 0)) {
    throw new Error("A race needs a positive time limit");
  }
  return {
    car,
    gate,
    distanceMetres,
    timeLimitSeconds,
    countdownSeconds,

    phase: STAGING,
    countdown: countdownSeconds,
    elapsed: 0,
    finishTime: null,

    vehicle: createCarState(car),
    // The fastest the car went, not the speed it happens to be doing at the end.
    // A distance race traps at the line so the two agree; a time attack does not.
    topSpeed: 0,

    // Launch. `falseStart` latches the moment the throttle is touched before the
    // green and is never cleared — a red light cannot be taken back.
    falseStart: false,
    // Seconds still on the tree when the light was jumped. Larger means the car
    // left earlier; the head-to-head rule in match.js uses it to break ties.
    falseStartAt: null,
    launched: false,
    reactionTime: null,
    launchGrade: null,

    // Live shift attempt, or null when the gate is closed.
    shift: null,
    rpmAtEngage: null,
    shiftOpenedAt: null,
    // The clutch has been asked for while the gas is still down. It goes in the
    // moment the player lifts, and not before — see `pressShift`.
    shiftArmed: false,
    // A shift whose gate has resolved but whose grade is still waiting on the
    // gas coming back. `{ result, clutchAt }`.
    pendingShift: null,
    // Last tick's throttle, so the rising edge that is the catch can be seen.
    throttleHeld: false,

    // Dead time before drive returns, and the post-shift reward window.
    clutchTimer: 0,
    boostTimer: 0,
    boostMultiplier: 1,

    lastShift: null,
    shifts: [],
  };
}

/** Leaves staging. A zero-length countdown goes straight to green. */
export function startRace(race) {
  if (race.phase !== STAGING) {
    return { ...race };
  }
  if (race.countdownSeconds <= 0) {
    return { ...race, phase: RUNNING, countdown: 0 };
  }
  return { ...race, phase: COUNTDOWN, countdown: race.countdownSeconds };
}

/**
 * True when the run ends on a clock rather than at a line. Renderers branch on
 * this rather than on a mode id, so the sim never has to carry one.
 */
export function isTimeAttack(race) {
  return race.timeLimitSeconds !== null;
}

/** How far through the objective the run is, 0..1, whichever it is measured in. */
export function raceProgress(race) {
  const fraction = isTimeAttack(race)
    ? race.elapsed / race.timeLimitSeconds
    : race.vehicle.distance / race.distanceMetres;
  return Math.max(0, Math.min(1, fraction));
}

/** True when the engine is actually driving the wheels. */
export function isClutchEngaged(race) {
  return race.shift === null && race.clutchTimer <= 0;
}

/** True while the car is waiting for the gas to come back after a shift. */
export function awaitingCatch(race) {
  return race.pendingShift !== null;
}

/**
 * Closes the pending shift with the offset between the gas coming back on and
 * the clutch biting. `null` means it never came back.
 *
 * This is where a shift finally lands in `shifts` and where its force
 * multiplier starts, which is why the flash the player sees appears at the
 * catch rather than when the knob lands.
 */
function settleCatch(race, deltaSeconds) {
  if (!race.pendingShift) {
    return race;
  }
  const result = finaliseShift(race.pendingShift.result, deltaSeconds);
  return {
    ...race,
    pendingShift: null,
    boostTimer: result.effects.boostSeconds,
    boostMultiplier: result.effects.forceMultiplier,
    lastShift: result,
    shifts: [...race.shifts, result],
  };
}

/**
 * Puts the clutch in and opens the gate. Split out of `pressShift` because the
 * gate can now open at two different moments: on the key, or later on the lift.
 *
 * The rpm is sampled here and nowhere else: the grade belongs to the moment the
 * clutch actually went in, not to whatever the needle has decayed to by the time
 * the knob lands.
 */
function openGate(race) {
  const opened = {
    ...race,
    shiftArmed: false,
    shift: beginShift(race.gate, race.vehicle.gear, race.vehicle.gear + 1),
    rpmAtEngage: race.vehicle.rpm,
    shiftOpenedAt: race.elapsed,
  };
  // Declutching again with the previous shift still uncaught settles it: the
  // gas was never picked up, and now the clutch is out again, so it never will
  // be. Chain-shifting without touching the throttle is legal and self-punishing.
  return settleCatch(opened, null);
}

/**
 * Asks for the clutch. Ignored unless the race is live, the gate is already
 * closed, and there is a gear above the current one to reach for.
 *
 * **You cannot declutch with your foot on the gas.** Rather than refusing the
 * key — which reads as a dead button while the engine sits on the limiter — the
 * clutch is *armed*: the gate opens by itself the instant the throttle is
 * released, and the rpm is sampled there. So the moment the player commits to a
 * shift is the lift, not the keypress, and there is no way to hold the throttle
 * through a shift at all.
 */
export function pressShift(race, controls) {
  if (race.phase !== RUNNING || race.shift !== null) {
    return { ...race };
  }
  if (!race.car.gearRatios[race.vehicle.gear + 1]) {
    return { ...race };
  }
  const throttle = controls?.throttle ?? 0;
  return throttle > 0 ? { ...race, shiftArmed: true } : openGate(race);
}

/**
 * Feeds one directional input to an open gate. Resolving the attempt engages the
 * gear the knob actually landed in — including the wrong one — and starts the
 * grade's clutch dead time.
 *
 * The grade itself is *not* settled here. The gear and the dead time happen now
 * and cannot wait, but the last input that decides the grade — the gas coming
 * back on — has not been made yet, so the result parks in `pendingShift` until
 * `stepRace` sees the catch.
 */
export function gateInput(race, direction) {
  if (race.phase !== RUNNING || race.shift === null) {
    return { ...race };
  }

  const attempt = applyShiftInput(race.gate, race.shift, direction);
  if (attempt.status === SHIFT_IN_GATE) {
    return { ...race, shift: attempt };
  }

  const result = resolveShift({
    car: race.car,
    rpmAtEngage: race.rpmAtEngage,
    attempt,
    durationSeconds: race.elapsed - race.shiftOpenedAt,
  });
  return {
    ...race,
    shift: null,
    rpmAtEngage: null,
    shiftOpenedAt: null,
    vehicle: { ...race.vehicle, gear: result.gear },
    clutchTimer: result.effects.clutchSeconds,
    // When the clutch will bite, which is what the catch is measured against.
    pendingShift: { result, clutchAt: race.elapsed + result.effects.clutchSeconds },
  };
}

/**
 * Advances the race by `dt` seconds. Staging and finished races are inert, so a
 * caller can keep ticking a completed race without special-casing it.
 */
export function stepRace(race, controls, dt) {
  if (race.phase === STAGING || race.phase === FINISHED) {
    return { ...race };
  }

  const throttle = controls?.throttle ?? 0;
  const throttleHeld = throttle > 0;
  // The throttle is a level, but a shift reads it as an event: the rise that
  // catches the clutch coming out is a press, not a hold, so a player who never
  // lifted has nothing to catch with.
  const pressed = throttleHeld && !race.throttleHeld;

  if (race.phase === COUNTDOWN) {
    // Throttle before the green is a foul, but the tree still runs its full
    // length — jumping the light must not also grant an early start.
    const jumpingNow = throttleHeld && !race.falseStart;
    const falseStart = race.falseStart || throttleHeld;
    const falseStartAt = jumpingNow ? race.countdown : race.falseStartAt;
    const countdown = race.countdown - dt;
    return countdown <= 1e-9
      ? { ...race, phase: RUNNING, countdown: 0, falseStart, falseStartAt, throttleHeld }
      : { ...race, countdown, falseStart, falseStartAt, throttleHeld };
  }

  // The throttle's two shift events, resolved before anything is integrated so
  // that whatever they change is true for the rest of the tick. `live` is the
  // race everything below reads: settling a catch adds to `shifts`, and spreading
  // the original race over that would throw it away.
  const live = applyThrottleEvents(race, { throttleHeld, pressed });

  // Launch is detected before any timer burns down, so the boost it grants runs
  // for its full duration starting this tick.
  let { launched, reactionTime, launchGrade, boostTimer, boostMultiplier } = live;
  if (!launched && throttleHeld) {
    launched = true;
    reactionTime = live.elapsed; // the clock started on green, so this is the RT
    launchGrade = gradeLaunch(reactionTime, { falseStart: live.falseStart });
    const launchEffects = launchEffectsFor(launchGrade);
    boostTimer = launchEffects.boostSeconds;
    boostMultiplier = launchEffects.forceMultiplier;
  }

  const clutchTimer = Math.max(0, live.clutchTimer - dt);
  const clutchEngaged = live.shift === null && clutchTimer <= 0;

  // The reward window only burns down while the car is actually driving, so a
  // good shift's bonus is never eaten by its own clutch dead time.
  boostTimer = clutchEngaged ? Math.max(0, boostTimer - dt) : boostTimer;
  const forceMultiplier = boostTimer > 0 ? boostMultiplier : 1;

  const vehicle = stepCar(live.car, live.vehicle, { throttle, clutchEngaged, forceMultiplier }, dt);

  const elapsed = live.elapsed + dt;
  const next = {
    ...live,
    vehicle,
    topSpeed: Math.max(live.topSpeed, vehicle.speed),
    clutchTimer,
    boostTimer,
    boostMultiplier,
    elapsed,
    launched,
    reactionTime,
    launchGrade,
    throttleHeld,
  };

  // Both objectives finish the same way: find where inside this tick the run
  // ended, and report the other quantity at that instant rather than at the tick
  // boundary. At 60hz an un-interpolated finish visibly quantises the result.
  if (isTimeAttack(live)) {
    if (elapsed >= live.timeLimitSeconds) {
      const fraction = dt > 0 ? (live.timeLimitSeconds - live.elapsed) / dt : 0;
      const travelled = vehicle.distance - live.vehicle.distance;
      return finishRace({
        ...next,
        vehicle: { ...vehicle, distance: live.vehicle.distance + travelled * fraction },
        elapsed: live.timeLimitSeconds,
        finishTime: live.timeLimitSeconds,
      });
    }
    return next;
  }

  if (vehicle.distance >= live.distanceMetres) {
    const travelled = vehicle.distance - live.vehicle.distance;
    const fraction = travelled > 0 ? (live.distanceMetres - live.vehicle.distance) / travelled : 0;
    return finishRace({ ...next, finishTime: live.elapsed + dt * fraction });
  }

  return next;
}

/**
 * The lift that lets the clutch in and the press that catches it coming out.
 * Both are throttle *edges* rather than levels, and both change the shape of the
 * race rather than its numbers, so they are resolved in one place at the top of
 * the tick.
 */
function applyThrottleEvents(race, { throttleHeld, pressed }) {
  // An armed clutch goes in the moment the gas comes off, and the rpm is
  // sampled there. The lift *is* the shift.
  const live = race.shiftArmed && !throttleHeld ? openGate(race) : race;
  if (!live.pendingShift) {
    return live;
  }

  const offset = live.elapsed - live.pendingShift.clutchAt;
  if (pressed) {
    return settleCatch(live, offset);
  }
  if (!throttleHeld && offset > CATCH_LOOSE_SECONDS) {
    // Past the window with the gas still off: nothing the player does from here
    // can make this a catch, so it is settled as a fumble now rather than
    // leaving the grade hanging until they happen to touch the throttle.
    return settleCatch(live, null);
  }
  return live;
}

/**
 * Ends the run. A shift still waiting on its catch when the line arrives is
 * settled as a fumble — otherwise it would never reach `shifts` and the results
 * screen would quietly under-count the run.
 */
function finishRace(race) {
  return { ...settleCatch(race, null), phase: FINISHED };
}
