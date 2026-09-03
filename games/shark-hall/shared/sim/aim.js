// Where the cue ball is pointed, and what it would hit.
//
// Pure geometry. No THREE, no DOM — which is the point: the aim guide the player
// sees and the shot search the CPU runs ask the same question, so they ask it of
// the same function. In the demo they did not, and the CPU could line up shots
// the guide would have shown as blocked.

import { BALL_RADIUS, HALF_LENGTH, HALF_WIDTH } from "./constants.js";
import { CUE } from "./balls.js";

/**
 * The first ball the cue ball would reach travelling at `angle`.
 *
 * A swept-circle test: solve for where the cue ball centre is exactly one ball
 * diameter from the target centre. The near root is the contact; a negative root
 * means the target is behind us.
 *
 * @returns `{ ball, distance, x, z }` at the ghost-ball position, or null.
 */
export function firstContact(balls, from, angle) {
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  let best = null;

  for (const ball of balls) {
    if (ball.n === CUE || ball.pocketed) continue;
    const ox = from.x - ball.x;
    const oz = from.z - ball.z;
    const b = 2 * (ox * dx + oz * dz);
    const c = ox * ox + oz * oz - 4 * BALL_RADIUS * BALL_RADIUS;
    const discriminant = b * b - 4 * c;
    if (discriminant < 0) continue;

    const distance = (-b - Math.sqrt(discriminant)) / 2;
    if (distance <= 0) continue;
    if (!best || distance < best.distance) {
      best = { ball, distance, x: from.x + dx * distance, z: from.z + dz * distance };
    }
  }

  return best;
}

/**
 * How far the cue ball can travel before the rails stop it.
 *
 * Deliberately the plain rectangle rather than `table.js`'s cushion runs: this
 * is only how long to draw the guide line when nothing is in the way, and a
 * guide that stopped short of a pocket mouth would read as a rail that is not
 * there. Never returns zero, so the line always exists.
 */
export function railDistance(from, angle) {
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  let distance = Infinity;

  if (dx > 0) distance = Math.min(distance, (HALF_LENGTH - BALL_RADIUS - from.x) / dx);
  if (dx < 0) distance = Math.min(distance, (-HALF_LENGTH + BALL_RADIUS - from.x) / dx);
  if (dz > 0) distance = Math.min(distance, (HALF_WIDTH - BALL_RADIUS - from.z) / dz);
  if (dz < 0) distance = Math.min(distance, (-HALF_WIDTH + BALL_RADIUS - from.z) / dz);

  return Math.max(0.05, distance);
}

/**
 * Everything the aim guide needs, in one shape.
 *
 * `object` is the direction the struck ball leaves along — the line from the
 * ghost-ball centre through the object ball centre, which is the actual cut
 * geometry rather than an eyeballed approximation of it.
 */
export function aimSolution(balls, from, angle) {
  const contact = firstContact(balls, from, angle);
  const distance = contact ? contact.distance : railDistance(from, angle);
  const end = { x: from.x + Math.cos(angle) * distance, z: from.z + Math.sin(angle) * distance };

  if (!contact) return { contact: null, distance, end, object: null };

  const nx = contact.ball.x - contact.x;
  const nz = contact.ball.z - contact.z;
  const length = Math.hypot(nx, nz) || 1;

  return {
    contact,
    distance,
    end,
    object: { x: nx / length, z: nz / length },
  };
}

/**
 * Is the straight line from (x1,z1) to (x2,z2) clear of other balls?
 *
 * The clearance is a touch over one ball diameter, because a path that scrapes a
 * ball by a hair is not a path any player would call open. `ignore` is a list of
 * ball numbers the line is allowed to pass through — the cue ball and whatever
 * is being aimed at.
 */
export function segmentBlocked(balls, x1, z1, x2, z2, ignore = []) {
  const vx = x2 - x1;
  const vz = z2 - z1;
  const lengthSquared = vx * vx + vz * vz;
  if (lengthSquared < 1e-8) return true;

  for (const ball of balls) {
    if (ball.pocketed || ignore.includes(ball.n)) continue;
    const t = Math.max(0, Math.min(1, ((ball.x - x1) * vx + (ball.z - z1) * vz) / lengthSquared));
    const distance = Math.hypot(ball.x - (x1 + vx * t), ball.z - (z1 + vz * t));
    if (distance < 2.12 * BALL_RADIUS) return true;
  }

  return false;
}

/** Wrap an angle into (-180, 180] degrees, for anything that displays it. */
export function angleToDegrees(angle) {
  let degrees = (angle * 180) / Math.PI;
  while (degrees > 180) degrees -= 360;
  while (degrees <= -180) degrees += 360;
  return degrees;
}

/**
 * Which ball, if any, is under a point on the table.
 *
 * Pure picking, so the hover readout does not need a raycast against the meshes
 * and the render layer keeps its monopoly on knowing a ball has one at all:
 * `scene.pointToTable` already projects the cursor onto the plane a ball's
 * centre rides, so the question reduces to "whose centre is nearest, and is it
 * close enough". The nearest wins rather than the first, because two balls
 * frozen together overlap at this reach.
 *
 * @param reach how far from a centre still counts as on the ball
 * @returns the ball, or null
 */
export function ballAt(balls, x, z, reach = BALL_RADIUS) {
  let best = null;
  let closest = reach;
  for (const ball of balls) {
    if (ball.pocketed) continue;
    const distance = Math.hypot(ball.x - x, ball.z - z);
    if (distance <= closest) {
      closest = distance;
      best = ball;
    }
  }
  return best;
}
