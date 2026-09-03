// Turning a stroke into a moving ball.
//
// Pure. Three inputs — where the cue points, how hard it was held, and where on
// the ball the tip landed — become one velocity and one angular velocity, and
// then `physics.js` takes over and nothing touches the cue ball again.
//
// THE CONTACT POINT IS NOT A SETTING. `spinY` high and `spinX` sideways become
// real angular velocity about real axes, and follow, draw and English are
// consequences of the sliding-friction term in `physics.js` acting on them. That
// is why a draw shot dies over distance without anything modelling that it
// should: the skid runs out.

import { BALL_RADIUS, FULL_CHARGE_MS, MAX_SHOT_SPEED, MIN_SHOT_SPEED } from "./constants.js";

/**
 * How much spin a fully off-centre tip imparts, as a multiple of natural roll.
 *
 * NOT a taste knob — it is the physics, and getting it wrong is why the demo had
 * no follow shot. A horizontal cue striking at height `h` above centre leaves the
 * ball spinning at `ω = 5vh / 2R²`. The tip cannot go past about half a radius
 * off centre without miscueing, so at maximum `h = R/2` and `ω = 1.25 v/R`.
 *
 * The number that matters is that 1.25 is GREATER THAN 1. Natural roll is
 * `v/R`; a ball spinning slower than that is still skidding and cloth friction
 * slows it down. The demo used 0.42, so its hardest follow shot was still under
 * natural roll and every "follow" was really a slightly softer stun — there was
 * no contact point anywhere on the ball that made it speed up after contact.
 */
const MAX_SPIN_RATIO = 1.25;

/**
 * The same, for spin about the vertical axis.
 *
 * The tip offset is the same, so the physics is the same — but English is
 * pulled back a little because unlike follow it has no natural equilibrium to
 * decay toward, and at full strength it makes every rail contact a swerve.
 */
const MAX_ENGLISH_RATIO = 0.95;

/**
 * Power from how long the shot button was held, 0..1.
 *
 * The exponent is below 1 on purpose, so the curve is steepest at the bottom:
 * the shots that need fine control are the soft ones, and a linear ramp spends
 * most of its travel on power levels nobody wants. A tap is a feather.
 */
export function heldPower(milliseconds) {
  const t = Math.max(0, Math.min(1, milliseconds / FULL_CHARGE_MS));
  return 0.055 + 0.945 * Math.pow(t, 0.82);
}

/** Cue-ball speed for a given power. Also mildly eased, for the same reason. */
export function shotSpeed(power) {
  const clamped = Math.max(0, Math.min(1, power));
  return MIN_SHOT_SPEED + (MAX_SHOT_SPEED - MIN_SHOT_SPEED) * Math.pow(clamped, 0.9);
}

/**
 * Clamp a cue contact point to the ball.
 *
 * The tip cannot land outside the circle, and a request that would is pulled
 * back to the rim rather than rejected — the player dragging past the edge of
 * the contact widget means maximum, not nothing.
 */
export function clampContact(spinX, spinY) {
  const length = Math.hypot(spinX, spinY);
  if (length <= 1) return { spinX, spinY };
  return { spinX: spinX / length, spinY: spinY / length };
}

/**
 * Strike the cue ball. Mutates it and returns the shot for anyone who wants it.
 *
 * `spinY` is vertical contact: positive is above centre (follow), negative below
 * (draw). It becomes angular velocity about the axis across the shot line.
 * `spinX` is horizontal contact and becomes spin about the vertical axis, which
 * only shows up when the ball touches something.
 */
export function strikeCue(ball, { angle, power, spinX = 0, spinY = 0 }) {
  const contact = clampContact(spinX, spinY);
  const speed = shotSpeed(power);
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);

  ball.vx = dx * speed;
  ball.vz = dz * speed;

  // Natural roll at this speed is `speed / R`. Follow overshoots it and draw
  // reverses it; see `MAX_SPIN_RATIO` for why the multiplier is above one.
  const rollRate = speed / BALL_RADIUS;
  ball.wx = dz * contact.spinY * rollRate * MAX_SPIN_RATIO;
  ball.wz = -dx * contact.spinY * rollRate * MAX_SPIN_RATIO;
  ball.wy = -contact.spinX * rollRate * MAX_ENGLISH_RATIO;

  return { angle, power, speed, spinX: contact.spinX, spinY: contact.spinY };
}

/** How the contact point reads in words, for the HUD. */
export function describeContact(spinX, spinY) {
  const vertical = spinY > 0.25 ? "follow" : spinY < -0.25 ? "draw" : null;
  const side = spinX > 0.25 ? "right English" : spinX < -0.25 ? "left English" : null;
  if (!vertical && !side) return "Center ball";
  return [vertical, side].filter(Boolean).join(" + ");
}
