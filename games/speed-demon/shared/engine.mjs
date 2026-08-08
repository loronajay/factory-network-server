// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/sim/engine.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

// Engine and drivetrain — pure functions over a plain car-state object.
//
// The drivetrain is treated as locked while the clutch is engaged, so engine rpm
// is *derived* from road speed and gear rather than integrated separately. That
// single choice is what makes the revs drop correctly the instant a shift lands,
// with no separate tuning and no chance of the tachometer disagreeing with the
// physics.
//
// Nothing here touches the DOM, canvas, or wall-clock time. All integration is
// caller-driven with an explicit `dt`, which keeps the sim deterministic and
// leaves the door open for lockstep online play.

import { RAD_PER_SEC_TO_RPM } from "./constants.mjs";

function ratioFor(car, gear) {
  const ratio = car.gearRatios[gear];
  if (typeof ratio !== "number") {
    throw new Error(`Car "${car.id}" has no ratio for gear ${gear}`);
  }
  return ratio;
}

/** Total drivetrain multiplication between the engine and the road. */
function totalRatio(car, gear) {
  return ratioFor(car, gear) * car.finalDrive;
}

/** Engine rpm implied by a road speed in a given gear, floored at idle. */
export function rpmForSpeed(car, gear, speed) {
  const wheelRadPerSec = speed / car.wheelRadius;
  const engineRadPerSec = wheelRadPerSec * totalRatio(car, gear);
  return Math.max(car.idleRpm, engineRadPerSec * RAD_PER_SEC_TO_RPM);
}

/** Road speed that produces a given rpm in a given gear. Inverse of the above. */
export function speedForRpm(car, gear, rpm) {
  const engineRadPerSec = rpm / RAD_PER_SEC_TO_RPM;
  return (engineRadPerSec / totalRatio(car, gear)) * car.wheelRadius;
}

/**
 * Torque curve: peaks at `peakTorqueRpm` and falls away either side, normalised
 * against the span between idle and the peak so the shape scales with any
 * engine's tuning.
 *
 * The falloff is asymmetric — steeper above the peak than below. That is both
 * more truthful to real engines and load-bearing for the game: with a symmetric
 * curve the power crossover between gears lands above the rev limiter, which
 * makes "hold every gear to the limiter" strictly optimal and reduces shift
 * timing to a non-decision.
 */
export function torqueAt(car, rpm) {
  if (rpm > car.limiterRpm) {
    return 0;
  }
  const span = car.peakTorqueRpm - car.idleRpm;
  const offset = (rpm - car.peakTorqueRpm) / span;
  const falloff = offset < 0 ? car.torqueFalloffBelow : car.torqueFalloffAbove;
  const factor = Math.max(car.minTorqueFactor, 1 - falloff * offset * offset);
  return car.peakTorqueNm * factor;
}

/**
 * Drive force at the contact patch, capped by available traction. The cap stands
 * in for a tyre model; it is applied last so a shift bonus can never conjure
 * grip that is not there.
 */
export function driveForceAt(car, gear, rpm, forceMultiplier = 1) {
  const torque = torqueAt(car, rpm);
  if (torque <= 0) {
    return 0;
  }
  const raw = (torque * totalRatio(car, gear) * car.driveEfficiency) / car.wheelRadius;
  return Math.min(car.maxTractionForce, raw * forceMultiplier);
}

/** Aerodynamic drag plus rolling resistance, in newtons, always opposing motion. */
export function resistanceAt(car, speed) {
  return car.dragK * speed * speed + car.rollK * speed;
}

export function createCarState(car, { gear = 1, speed = 0, distance = 0 } = {}) {
  return {
    gear,
    speed,
    distance,
    rpm: rpmForSpeed(car, gear, speed),
    atLimiter: false,
  };
}

/**
 * Advances the car by `dt` seconds.
 *
 * `controls.clutchEngaged` is false while the shifter gate is open: drive force
 * disappears but resistance does not, so time spent fumbling the gate is time
 * spent not accelerating. `controls.forceMultiplier` is the hook shift grading
 * uses to reward or punish the player coming out of a shift.
 *
 * Returns a new state object; the input is never mutated.
 */
export function stepCar(car, state, controls, dt) {
  const { throttle = 0, clutchEngaged = true, forceMultiplier = 1 } = controls ?? {};

  // With the clutch in, rpm is whatever the current speed and gear imply — never
  // the value carried over from the previous tick. This matters on the tick the
  // clutch re-engages after a shift, where the stored rpm is still the decayed
  // free-revving figure from the gear the car has just left.
  const workingRpm = clutchEngaged ? rpmForSpeed(car, state.gear, state.speed) : state.rpm;
  const drive = clutchEngaged ? driveForceAt(car, state.gear, workingRpm, forceMultiplier) * throttle : 0;
  const netForce = drive - resistanceAt(car, state.speed);

  let speed = state.speed + (netForce / car.mass) * dt;
  if (speed < 0) {
    speed = 0; // resistance brings a car to rest; it never pushes it backwards
  }

  let rpm;
  let atLimiter = false;
  if (clutchEngaged) {
    // The limiter caps engine speed, which in a locked drivetrain caps road
    // speed too. Clamping here keeps the needle and the physics in agreement
    // instead of letting the integration step overshoot the redline.
    const limiterSpeed = speedForRpm(car, state.gear, car.limiterRpm);
    if (speed > limiterSpeed) {
      speed = limiterSpeed;
      atLimiter = true;
    }
    rpm = rpmForSpeed(car, state.gear, speed);
  } else {
    // Clutch in, so the engine is free of the road. Gas flares it toward the
    // limiter and off the gas it falls back to idle. None of this reaches the
    // wheels — its whole job is to put "you are still on the gas with the clutch
    // down" on the tachometer, where the player can see it.
    rpm =
      throttle > 0
        ? Math.min(car.limiterRpm, state.rpm + car.rpmRisePerSecond * dt)
        : Math.max(car.idleRpm, state.rpm - car.rpmDecayPerSecond * dt);
  }

  return {
    gear: state.gear,
    speed,
    distance: state.distance + speed * dt,
    rpm,
    atLimiter,
  };
}
