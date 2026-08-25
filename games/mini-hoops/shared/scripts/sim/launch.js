// Turning a resolved pull into a launch velocity.
//
// The solver works BACKWARD from the shot the player asked for. Given where the
// ball is, where the reticle is, and how steep the arc should be, it computes the
// exact velocity that would drop the ball through that point with the requested
// descent — and then scales that perfect shot by how far the player's pull was
// from the calibrated reference.
//
// That last step is the whole design. `REFERENCE_POWER` (80%) is the swish: pull
// to exactly that and the maths lands the ball on the reticle. Pull harder and
// you overshoot by precisely the ratio; pull softer and you come up short by it.
// So the power meter is not a difficulty dial with a hidden forgiveness window —
// it reports a real, linear, physical relationship, and 100% is exactly 25%
// faster than the shot that goes in.
//
// Note what is NOT here: no aim assist, no snapping to the live rim, no
// correction for a moving hoop. The reticle is where the player pointed, and
// leading a moving rim is the player's job.
//
// Pure functions. No state, no canvas.

import {
  BALL_RADIUS_WORLD,
  GRAVITY,
  LAUNCH_MIN_DEPTH_SPEED,
  LAUNCH_MIN_RISE,
  LAUNCH_SPIN_BASE,
  LAUNCH_SPIN_PER_LOFT,
  MAX_EXIT_VY,
  MIN_EXIT_VY,
  REFERENCE_POWER,
  RIM_CENTER_Z,
} from "./constants.js";
import { screenToWorldAtZ } from "./projection.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * The vertical speed the ball should be carrying as it arrives at the rim.
 *
 * Negative is descending. A fully lofted shot arrives steeply (forgiving: it
 * drops into the ring rather than at it); a flat shot arrives shallow.
 */
export function entryVelocityForLoft(loft) {
  return MIN_EXIT_VY + (MAX_EXIT_VY - MIN_EXIT_VY) * clamp(loft, 0, 1);
}

/**
 * Solve the launch.
 *
 * THE SOLVER KNOWS THE BALL'S WEIGHT AND NOT ITS DRAG, and that split is the
 * whole of how balls differ. Weight is compensated — solve against the ball's
 * own gravity and the reference pull still swishes, so a heavy ball changes the
 * SHAPE of the arc rather than punishing the hand that has already learned the
 * meter. Drag is not compensated, and is applied later by `sim/physics.js`: a
 * draggy ball genuinely lands short of the reticle, which is a real number the
 * player has to find for that ball. Compensating both would make every ball fly
 * identically; compensating neither would make the meter dishonest per ball.
 *
 * @param origin world-space position of the ball, `{x, y, z}`
 * @param aim    SCREEN-space reticle position, `{x, y}` — resolved onto the rim plane here
 * @param power  0..1, straight from the pull length
 * @param loft   0..1, straight from the pull angle
 * @param weight the ball's gravity multiplier, from `ballFlight`. 1 is the house ball.
 */
export function solveLaunch({ origin, aim, power, loft, weight = 1, targetZ = RIM_CENTER_Z, entryVelocity = null }) {
  const clampedPower = clamp(power, 0, 1);
  const clampedLoft = clamp(loft, 0, 1);
  // Guarded rather than trusted: a zero or negative weight would divide the
  // flight time by zero and fire the ball at infinity.
  const gravity = GRAVITY * Math.max(0.05, Number.isFinite(weight) ? weight : 1);

  // Honest power: velocity scales linearly against the calibrated reference pull.
  const powerScale = clampedPower / REFERENCE_POWER;

  const entryVy = Number.isFinite(entryVelocity) && entryVelocity < 0
    ? entryVelocity
    : entryVelocityForLoft(clampedLoft);
  const safeTargetZ = Number.isFinite(targetZ) ? targetZ : RIM_CENTER_Z;
  const target = screenToWorldAtZ(aim.x, aim.y, safeTargetZ);

  // How far the ball has to climb. Floored so a target level with (or below) the
  // launch point still yields a real, positive flight time.
  const rise = Math.max(LAUNCH_MIN_RISE, target.y - origin.y);

  // Flight time for a ball that rises `rise` and arrives with vertical speed
  // `entryVy`: the positive root of  0.5*g*t^2 + entryVy*t - rise = 0.
  const flightTime = (-entryVy + Math.sqrt(entryVy * entryVy + 2 * gravity * rise)) / gravity;

  // The exact velocity that lands on the reticle...
  const perfectVx = (target.x - origin.x) / flightTime;
  const perfectVy = entryVy + gravity * flightTime;
  const perfectVz = (safeTargetZ - origin.z) / flightTime;

  // ...scaled by how far off the reference the player actually pulled.
  const vx = perfectVx * powerScale;
  const vy = perfectVy * powerScale;
  const vz = perfectVz * powerScale;

  return {
    vx,
    vy,
    vz,
    power: clampedPower,
    powerScale,
    loft: clampedLoft,
    entryVy,
    flightTime,
    // Carried out so the trajectory preview bends by the same gravity the ball
    // will actually fall under, rather than re-deriving it from the ball id.
    gravity,
    // Roughly when the ball reaches the rim plane. Used to decide how far to draw
    // the trajectory preview, not by the physics — the physics finds the plane by
    // actually integrating to it.
    targetZ: safeTargetZ,
    planeTime: (safeTargetZ - origin.z) / Math.max(LAUNCH_MIN_DEPTH_SPEED, vz),
  };
}

/**
 * Angular velocity, in radians/second, about the screen-horizontal axis.
 *
 * The ball's animation frame is derived from this rather than from a timer, so
 * spin is real: a shot that leaves with backspin visibly rolls backward, and a
 * ball that scrubs speed off the rim visibly slows its roll.
 */
export function launchSpin(launch) {
  return (launch.vz / BALL_RADIUS_WORLD) * (LAUNCH_SPIN_BASE + LAUNCH_SPIN_PER_LOFT * launch.loft);
}

/**
 * Sample the un-obstructed flight path, for the aiming preview.
 *
 * Deliberately ignores every collider: it shows where the ball is *thrown*, not
 * where it ends up. Showing the true post-bounce path would hand the player the
 * answer the shot is supposed to be asking.
 */
export function trajectoryPoints(origin, launch, { step = 0.06, maxSeconds = 1.45 } = {}) {
  const limit = Math.min(maxSeconds, Math.max(step, launch.planeTime * 1.04));
  // A launch solved before `gravity` existed on it still previews correctly.
  const gravity = Number.isFinite(launch.gravity) ? launch.gravity : GRAVITY;
  const points = [];
  for (let t = step; t < limit; t += step) {
    points.push({
      x: origin.x + launch.vx * t,
      y: origin.y + launch.vy * t - 0.5 * gravity * t * t,
      z: origin.z + launch.vz * t,
    });
  }
  return points;
}
