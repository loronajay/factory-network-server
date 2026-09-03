// What a ball IS, and where fifteen of them start.
//
// The single most important line in this cabinet is the one that is missing: a
// ball has no mesh. In the demo every ball owned its own THREE.Mesh, which meant
// the physics could not run without a GPU, could not be tested, and could not be
// mirrored by a server. Here a ball is nine numbers and a flag, the renderer
// keeps its own meshes keyed by number, and `render/balls-view.js` is the only
// file that knows the two are related.
//
// Pure. No THREE, no DOM.

import { BALL_RADIUS, BREAK_CUE_X, RACK_APEX_X } from "./constants.js";

/** The cue ball's number. It is a ball like any other to the physics. */
export const CUE = 0;
export const EIGHT = 8;

/** @typedef {"solid"|"stripe"} Group */

/**
 * @typedef {object} Ball
 * @property {number} n        0 is the cue ball, 1-15 the objects
 * @property {number} x        position on the cloth
 * @property {number} z
 * @property {number} vx       velocity
 * @property {number} vz
 * @property {number} wx       angular velocity, world axes, y up
 * @property {number} wy       spin about vertical — English
 * @property {number} wz
 * @property {boolean} pocketed
 */

export function createBall(n, x, z) {
  return { n, x, z, vx: 0, vz: 0, wx: 0, wy: 0, wz: 0, pocketed: false };
}

/** Which group a number belongs to. The 8 and the cue ball belong to neither. */
export function groupOf(n) {
  if (n >= 1 && n <= 7) return "solid";
  if (n >= 9 && n <= 15) return "stripe";
  return null;
}

export function inGroup(n, group) {
  return group !== null && groupOf(n) === group;
}

/** The other group. Null in, null out — the table is open until it is not. */
export function opposingGroup(group) {
  if (group === "solid") return "stripe";
  if (group === "stripe") return "solid";
  return null;
}

/** How many of a group are still on the table. An open table has nothing to count. */
export function remaining(balls, group) {
  if (!group) return 0;
  return balls.filter((ball) => !ball.pocketed && inGroup(ball.n, group)).length;
}

export function cueBall(balls) {
  return balls.find((ball) => ball.n === CUE) || null;
}

/**
 * A legal 8-ball rack: the 8 in the middle of the third row, and a solid and a
 * stripe in the two back corners.
 *
 * Rows are listed apex-first. The 1.014 factor is a hair of slack between
 * neighbours — a rack built at exactly touching distance starts every ball
 * inside its neighbour's collision radius, and the first substep detonates it.
 */
const RACK_ROWS = Object.freeze([
  Object.freeze([1]),
  Object.freeze([10, 2]),
  Object.freeze([3, 8, 12]),
  Object.freeze([14, 4, 6, 11]),
  Object.freeze([7, 13, 15, 5, 9]),
]);

const RACK_SLACK = 1.014;

/** A fresh rack: the cue ball on the head spot and fifteen balls in the triangle. */
export function rackBalls() {
  const balls = [createBall(CUE, BREAK_CUE_X, 0)];
  const rowSpacing = Math.sqrt(3) * BALL_RADIUS * RACK_SLACK;
  const ballSpacing = 2 * BALL_RADIUS * RACK_SLACK;

  RACK_ROWS.forEach((row, rowIndex) => {
    row.forEach((n, seat) => {
      balls.push(createBall(n, RACK_APEX_X + rowIndex * rowSpacing, (seat - rowIndex / 2) * ballSpacing));
    });
  });

  return balls;
}

/**
 * A detached copy of a table.
 *
 * Nine numbers and a flag is the whole of a ball, so a table copies with a
 * spread and nothing is shared afterwards. This is what lets an authoritative
 * table be handed across a wire and adopted without the sender and the receiver
 * ending up holding the same array.
 */
export function cloneBalls(balls) {
  return balls.map((ball) => ({ ...ball }));
}

/** Speed of a ball along the cloth. Vertical spin is not motion. */
export function speedOf(ball) {
  return Math.hypot(ball.vx, ball.vz);
}

/** Stop a ball dead — used by pocketing and by placing the cue ball. */
export function stillBall(ball) {
  ball.vx = 0;
  ball.vz = 0;
  ball.wx = 0;
  ball.wy = 0;
  ball.wz = 0;
  return ball;
}
