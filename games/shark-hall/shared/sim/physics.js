// Impulses, friction, and the contacts that make up one substep.
//
// Pure. Given balls and a dt it mutates positions and velocities and reports
// what happened; it never draws, never plays a sound and never decides whose
// turn it is.
//
// TWO THINGS HERE ARE REAL PHYSICS RATHER THAN AN APPROXIMATION, and they are
// what make the table feel like a table:
//
// SPIN IS ANGULAR VELOCITY, NOT A MODIFIER. Cue contact becomes wx/wy/wz, the
// sliding-friction term below converts that into linear motion over the first
// fraction of a second of the shot, and follow and draw fall out of it. Nothing
// anywhere fakes them by adjusting shot speed after the fact.
//
// CONTACT POINTS CARRY THAT SPIN. Every impulse is applied at the contact point
// rather than at the centre, so English survives a cushion and throws an object
// ball off the geometric tangent line. That is the `r x J` torque term.
//
// EVENTS ARE REPORTED, NOT PLAYED. Each contact appends a record to a sink the
// caller owns; `world.js` drains it and `audio/game-audio.js` listens. The
// physics stays deaf, which is what keeps it runnable under node.

import {
  BALL_FRICTION,
  BALL_INERTIA,
  BALL_MASS,
  BALL_RADIUS,
  BALL_RESTITUTION,
  CORNER_GAP,
  CUSHION_FRICTION,
  CUSHION_RESTITUTION_FALLOFF,
  CUSHION_RESTITUTION_LOW,
  CUSHION_RESTITUTION_MIN,
  GRAVITY,
  HALF_LENGTH,
  HALF_WIDTH,
  JAW_RADIUS,
  ROLL_FRICTION,
  ROLL_SLIP,
  SIDE_GAP,
  SLIDE_FRICTION,
  SNAP_SPEED,
  SPIN_DECAY,
} from "./constants.js";
import { JAWS } from "./table.js";
import { CUE } from "./balls.js";

/**
 * Apply an impulse at a contact point offset (rx, rz) from the ball centre.
 *
 * The cross product is written out for a y-up frame: only the vertical
 * component of `r x J` is non-zero for a contact in the plane of the cloth, so
 * an off-centre impulse spins the ball about its vertical axis and nothing else.
 */
function applyImpulse(ball, jx, jz, rx = 0, rz = 0) {
  ball.vx += jx / BALL_MASS;
  ball.vz += jz / BALL_MASS;
  ball.wy += (rz * jx - rx * jz) / BALL_INERTIA;
}

/**
 * Resolve a ball-ball contact.
 *
 * Returns the closing speed along the normal if they actually collided, or 0 if
 * they were separating or apart. That number is the impact strength, and it is
 * what the audio layer turns into how loud the clack is.
 */
export function collideBalls(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= 0 || distance >= 2 * BALL_RADIUS) return 0;

  const nx = dx / distance;
  const nz = dz / distance;

  // Push them apart first. Overlapping balls that are also separating still
  // need this, or a settled cluster slowly sinks into itself.
  const overlap = 2 * BALL_RADIUS - distance;
  a.x -= nx * overlap * 0.501;
  a.z -= nz * overlap * 0.501;
  b.x += nx * overlap * 0.501;
  b.z += nz * overlap * 0.501;

  const rax = nx * BALL_RADIUS;
  const raz = nz * BALL_RADIUS;
  const rbx = -nx * BALL_RADIUS;
  const rbz = -nz * BALL_RADIUS;

  // Surface velocities at the contact patch, which include each ball's English.
  const avx = a.vx + a.wy * raz;
  const avz = a.vz - a.wy * rax;
  const bvx = b.vx + b.wy * rbz;
  const bvz = b.vz - b.wy * rbx;

  const rvx = bvx - avx;
  const rvz = bvz - avz;
  const normalSpeed = rvx * nx + rvz * nz;
  if (normalSpeed >= 0) return 0;

  const jn = (-(1 + BALL_RESTITUTION) * normalSpeed) / (2 / BALL_MASS);
  applyImpulse(a, -jn * nx, -jn * nz, rax, raz);
  applyImpulse(b, jn * nx, jn * nz, rbx, rbz);

  // Tangential friction, capped by Coulomb. This is what throws a cut shot off
  // the geometric tangent when the cue ball arrives carrying side.
  const tx = -nz;
  const tz = nx;
  const tangentSpeed = rvx * tx + rvz * tz;
  const cap = BALL_FRICTION * Math.abs(jn);
  const raw = -tangentSpeed / (2 / BALL_MASS + (2 * BALL_RADIUS * BALL_RADIUS) / BALL_INERTIA);
  const jt = Math.max(-cap, Math.min(cap, raw));
  applyImpulse(a, -jt * tx, -jt * tz, rax, raz);
  applyImpulse(b, jt * tx, jt * tz, rbx, rbz);

  return -normalSpeed;
}

/**
 * How elastic the cushion is for an impact arriving at this speed.
 *
 * Exported because it is a claim about the table rather than an implementation
 * detail, and `tests/physics.test.js` checks the claim directly. Linear between
 * the low-speed value and the floor; see the constants for why it is not flat.
 */
export function cushionRestitution(closingSpeed) {
  const e = CUSHION_RESTITUTION_LOW - CUSHION_RESTITUTION_FALLOFF * Math.abs(closingSpeed);
  return Math.max(CUSHION_RESTITUTION_MIN, Math.min(CUSHION_RESTITUTION_LOW, e));
}

/**
 * Resolve a contact with a cushion whose inward normal is (nx, nz).
 *
 * Returns the closing speed, or 0 if the ball was already leaving. The contact
 * point sits on the far side of the ball from the normal, which is what lets
 * English come off the rail as a changed exit angle instead of being ignored.
 */
export function collideCushion(ball, nx, nz) {
  const rx = -nx * BALL_RADIUS;
  const rz = -nz * BALL_RADIUS;
  const cvx = ball.vx + ball.wy * rz;
  const cvz = ball.vz - ball.wy * rx;

  const normalSpeed = cvx * nx + cvz * nz;
  if (normalSpeed >= 0) return 0;

  const jn = -(1 + cushionRestitution(normalSpeed)) * normalSpeed * BALL_MASS;
  applyImpulse(ball, jn * nx, jn * nz, rx, rz);

  const tx = -nz;
  const tz = nx;
  const tangentSpeed = cvx * tx + cvz * tz;
  const cap = CUSHION_FRICTION * Math.abs(jn);
  const raw = -tangentSpeed / (1 / BALL_MASS + (BALL_RADIUS * BALL_RADIUS) / BALL_INERTIA);
  const jt = Math.max(-cap, Math.min(cap, raw));
  applyImpulse(ball, jt * tx, jt * tz, rx, rz);

  return -normalSpeed;
}

/** A rounded pocket facing: the same maths as a ball against a fixed circle. */
function collideJaw(ball, jawX, jawZ) {
  const dx = ball.x - jawX;
  const dz = ball.z - jawZ;
  const distance = Math.hypot(dx, dz);
  const minimum = BALL_RADIUS + JAW_RADIUS;
  if (distance <= 0 || distance >= minimum) return 0;

  const nx = dx / distance;
  const nz = dz / distance;
  ball.x += nx * (minimum - distance);
  ball.z += nz * (minimum - distance);
  return collideCushion(ball, nx, nz);
}

/**
 * Every rail and jaw contact for one ball.
 *
 * The straight runs are checked against the same gap widths `table.js` builds
 * the cushion meshes from, so a ball only meets a rail where the player can see
 * one; everywhere else it is over a pocket mouth and the jaws take it.
 *
 * @returns how many contacts occurred. The rules layer needs the count, not the
 *   sink: "did any ball reach a rail after contact" is a rule, and reading it
 *   back out of an event list the audio also consumes would couple the two.
 */
export function collideRails(ball, sink) {
  let contacts = 0;
  const report = (kind, speed) => {
    if (speed <= 0) return;
    contacts++;
    if (sink) sink.push({ type: "cushion", kind, n: ball.n, speed, x: ball.x, z: ball.z });
  };

  // Long rails, interrupted by the side pocket and the two corners.
  const overLongGap = Math.abs(ball.x) <= SIDE_GAP || Math.abs(ball.x) >= HALF_LENGTH - CORNER_GAP;
  if (!overLongGap) {
    if (ball.z > HALF_WIDTH - BALL_RADIUS) {
      ball.z = HALF_WIDTH - BALL_RADIUS;
      report("rail", collideCushion(ball, 0, -1));
    } else if (ball.z < -HALF_WIDTH + BALL_RADIUS) {
      ball.z = -HALF_WIDTH + BALL_RADIUS;
      report("rail", collideCushion(ball, 0, 1));
    }
  }

  // Short rails, interrupted only by their two corners.
  const overShortGap = Math.abs(ball.z) >= HALF_WIDTH - CORNER_GAP;
  if (!overShortGap) {
    if (ball.x > HALF_LENGTH - BALL_RADIUS) {
      ball.x = HALF_LENGTH - BALL_RADIUS;
      report("rail", collideCushion(ball, -1, 0));
    } else if (ball.x < -HALF_LENGTH + BALL_RADIUS) {
      ball.x = -HALF_LENGTH + BALL_RADIUS;
      report("rail", collideCushion(ball, 1, 0));
    }
  }

  for (const jaw of JAWS) report("jaw", collideJaw(ball, jaw.x, jaw.z));

  return contacts;
}

/**
 * Push a ball back inside the nose line, without touching its velocity.
 *
 * `collideRails` clamps as part of resolving a bounce, but it runs BEFORE
 * `collideAll` in the substep, and separating two overlapping balls can shove
 * one of them a few millimetres into a rail that has already been resolved this
 * step. It is corrected on the next substep either way, so the sim never cared
 * — but the renderer draws the frame in between, and a ball visibly sinking
 * into the cushion is exactly the artefact the cushion mesh was moved to fix.
 * So the last thing a substep does is put every ball back on the cloth.
 *
 * Position only, deliberately: a ball nudged out of a rail by its neighbour has
 * not struck the rail, and reporting a contact here would invent cushions the
 * "rail after contact" rule would then count.
 */
export function clampToCloth(ball) {
  const overLongGap = Math.abs(ball.x) <= SIDE_GAP || Math.abs(ball.x) >= HALF_LENGTH - CORNER_GAP;
  if (!overLongGap) {
    const limit = HALF_WIDTH - BALL_RADIUS;
    if (ball.z > limit) ball.z = limit;
    else if (ball.z < -limit) ball.z = -limit;
  }

  const overShortGap = Math.abs(ball.z) >= HALF_WIDTH - CORNER_GAP;
  if (!overShortGap) {
    const limit = HALF_LENGTH - BALL_RADIUS;
    if (ball.x > limit) ball.x = limit;
    else if (ball.x < -limit) ball.x = -limit;
  }
}

/**
 * Cloth friction for one ball over one substep.
 *
 * The branch is the whole model. While the contact patch is skidding, sliding
 * friction acts on it and applies an equal and opposite torque, and that is the
 * term that turns cue spin into follow and draw. Once the skid dies the ball is
 * rolling naturally and only the much smaller rolling resistance remains, with
 * the spin locked to the velocity so it cannot drift back into a skid.
 */
export function applyClothFriction(ball, dt) {
  const slipX = ball.vx + ball.wz * BALL_RADIUS;
  const slipZ = ball.vz - ball.wx * BALL_RADIUS;
  const slip = Math.hypot(slipX, slipZ);

  if (slip > ROLL_SLIP) {
    const deceleration = SLIDE_FRICTION * GRAVITY;
    const ax = (-slipX / slip) * deceleration;
    const az = (-slipZ / slip) * deceleration;
    ball.vx += ax * dt;
    ball.vz += az * dt;
    ball.wx += ((-BALL_RADIUS * az * BALL_MASS) / BALL_INERTIA) * dt;
    ball.wz += ((BALL_RADIUS * ax * BALL_MASS) / BALL_INERTIA) * dt;
  } else {
    const speed = Math.hypot(ball.vx, ball.vz);
    if (speed > 1e-4) {
      const drop = ROLL_FRICTION * GRAVITY * dt;
      if (drop >= speed) {
        ball.vx = 0;
        ball.vz = 0;
      } else {
        ball.vx *= 1 - drop / speed;
        ball.vz *= 1 - drop / speed;
      }
      ball.wx = ball.vz / BALL_RADIUS;
      ball.wz = -ball.vx / BALL_RADIUS;
    }
  }

  // English is not opposed by rolling; it only bleeds away against the cloth.
  ball.wy *= Math.exp(-SPIN_DECAY * dt);

  if (Math.hypot(ball.vx, ball.vz) < SNAP_SPEED && slip < ROLL_SLIP * 0.87) {
    ball.vx = 0;
    ball.vz = 0;
    if (Math.abs(ball.wy) < 0.08) ball.wy = 0;
  }
}

/**
 * Ball-ball collisions across the whole table, reported to the sink.
 *
 * The first ball the cue ball touched is RETURNED rather than remembered here,
 * because which ball was struck first is a rules fact and the rules layer owns
 * it. Physics only says that a pair touched and how hard.
 */
export function collideAll(balls, sink) {
  let firstCueContact = null;
  for (let i = 0; i < balls.length; i++) {
    if (balls[i].pocketed) continue;
    for (let j = i + 1; j < balls.length; j++) {
      if (balls[j].pocketed) continue;
      const speed = collideBalls(balls[i], balls[j]);
      if (speed <= 0) continue;
      const a = balls[i];
      const b = balls[j];
      if (sink) sink.push({ type: "ball", a: a.n, b: b.n, speed, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
      if (firstCueContact === null) {
        if (a.n === CUE) firstCueContact = b.n;
        else if (b.n === CUE) firstCueContact = a.n;
      }
    }
  }
  return firstCueContact;
}
