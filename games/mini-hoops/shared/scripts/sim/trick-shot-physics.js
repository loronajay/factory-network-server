// Pure collision/runtime rules for reusable sandbox pieces.
//
// The main ball integrator continues to own gravity, room, rim, and backboard.
// Trick Shot Lab calls this once per physics substep after that integration, so
// thin neon boards cannot be skipped at 60 Hz and cannon timing is deterministic.

import { BALL_RADIUS_WORLD } from "./constants.js";
import {
  BOARD_PAD_THICKNESS,
  BOARD_PIECE,
  CANNON_PIECE,
  SPRING_PIECE,
  boardFrame,
  cannonDirection,
  isPadPiece,
} from "./trick-shot.js";

// The cannon's own measurements. Exported because they are not private to the
// collider: `sim/horse-plan.js` has to know where a mouth sits before it can
// drop one under a ball, and where a muzzle points before it can solve the
// flight out of one. A second copy of these numbers would be a planner that
// aimed a cannon it was not actually holding.
export const CANNON_MOUTH_RADIUS = 0.135;
export const CANNON_MOUTH_HEIGHT = 0.08;
export const CANNON_MUZZLE_CLEARANCE = 0.17;
export const CANNON_COOLDOWN = 0.22;

export function createTrickShotPhysics() {
  return { capture: null, cooldowns: Object.create(null) };
}

export function resetTrickShotPhysics(runtime) {
  runtime.capture = null;
  runtime.cooldowns = Object.create(null);
  return runtime;
}

function tickCooldowns(runtime, dt) {
  for (const id of Object.keys(runtime.cooldowns)) {
    runtime.cooldowns[id] -= dt;
    if (runtime.cooldowns[id] <= 0) delete runtime.cooldowns[id];
  }
}

function holdOrLaunch(ball, pieces, runtime, dt) {
  if (!runtime.capture) return null;
  const cannon = pieces.find((piece) => piece.type === CANNON_PIECE && piece.id === runtime.capture.pieceId);
  if (!cannon) {
    runtime.capture = null;
    return { contacts: [], impacts: [], touched: [], captured: false, launched: false };
  }

  ball.x = cannon.x;
  ball.y = cannon.y + CANNON_MOUTH_HEIGHT;
  ball.z = cannon.z;
  ball.vx = 0;
  ball.vy = 0;
  ball.vz = 0;
  ball.omegaX = 0;
  runtime.capture.remaining -= dt;
  if (runtime.capture.remaining > 1e-9) {
    return { contacts: [], impacts: [], touched: [], captured: true, launched: false };
  }

  const direction = cannonDirection(cannon);
  ball.x = cannon.x + direction.x * CANNON_MUZZLE_CLEARANCE;
  ball.y = cannon.y + CANNON_MOUTH_HEIGHT + direction.y * CANNON_MUZZLE_CLEARANCE;
  ball.z = cannon.z + direction.z * CANNON_MUZZLE_CLEARANCE;
  ball.vx = direction.x * cannon.speed;
  ball.vy = direction.y * cannon.speed;
  ball.vz = direction.z * cannon.speed;
  ball.omegaX = cannon.speed / BALL_RADIUS_WORLD;
  runtime.cooldowns[cannon.id] = CANNON_COOLDOWN;
  runtime.capture = null;
  // The CATCH is what reported this cannon as touched; firing is the same
  // contact finishing. Reporting it twice would let one tool satisfy a duty it
  // was only asked for once.
  return { contacts: ["sandbox-cannon-fire"], impacts: [], touched: [], captured: false, launched: true };
}

function catchWithCannon(ball, previous, cannon, runtime) {
  if (runtime.cooldowns[cannon.id] > 0 || ball.vy >= 0) return false;
  const mouthY = cannon.y + CANNON_MOUTH_HEIGHT;
  // The centre crosses the lip plane downward inside a circular x/z mouth.
  if (previous.y < mouthY || ball.y > mouthY) return false;
  if (Math.hypot(ball.x - cannon.x, ball.z - cannon.z) > CANNON_MOUTH_RADIUS) return false;

  runtime.capture = { pieceId: cannon.id, remaining: cannon.delay };
  ball.x = cannon.x;
  ball.y = mouthY;
  ball.z = cannon.z;
  ball.vx = 0;
  ball.vy = 0;
  ball.vz = 0;
  ball.omegaX = 0;
  return true;
}

function resolvePad(ball, previous, board) {
  const halfFace = board.length / 2;
  const halfDepth = BOARD_PAD_THICKNESS / 2;
  const { normal, right, up } = boardFrame(board);
  const relative = { x: ball.x - board.x, y: ball.y - board.y, z: ball.z - board.z };
  const local = {
    x: relative.x * right.x + relative.y * right.y + relative.z * right.z,
    y: relative.x * up.x + relative.y * up.y + relative.z * up.z,
    z: relative.x * normal.x + relative.y * normal.y + relative.z * normal.z,
  };
  const closestLocal = {
    x: Math.max(-halfFace, Math.min(halfFace, local.x)),
    y: Math.max(-halfFace, Math.min(halfFace, local.y)),
    z: Math.max(-halfDepth, Math.min(halfDepth, local.z)),
  };
  let dx = local.x - closestLocal.x;
  let dy = local.y - closestLocal.y;
  let dz = local.z - closestLocal.z;
  let distance = Math.hypot(dx, dy, dz);
  if (distance >= BALL_RADIUS_WORLD) return null;

  if (distance < 1e-8) {
    // The centre is inside the thin box. Choose the nearest broad face, using
    // the incoming side as the tie-breaker, so a fast centred hit remains
    // finite and never rebounds from an arbitrary edge.
    const previousRelative = {
      x: previous?.x - board.x,
      y: previous?.y - board.y,
      z: previous?.z - board.z,
    };
    const previousNormal = Number.isFinite(previousRelative.x)
      ? previousRelative.x * normal.x + previousRelative.y * normal.y + previousRelative.z * normal.z
      : local.z;
    dz = previousNormal < 0 ? -1 : 1;
    dx = 0;
    dy = 0;
    distance = 1;
    closestLocal.z = dz < 0 ? -halfDepth : halfDepth;
  }

  const localNormal = { x: dx / distance, y: dy / distance, z: dz / distance };
  const nx = right.x * localNormal.x + up.x * localNormal.y + normal.x * localNormal.z;
  const ny = right.y * localNormal.x + up.y * localNormal.y + normal.y * localNormal.z;
  const nz = right.z * localNormal.x + up.z * localNormal.y + normal.z * localNormal.z;

  const normalSpeed = ball.vx * nx + ball.vy * ny + ball.vz * nz;
  if (board.type === SPRING_PIECE) {
    if (normalSpeed >= board.speed) return null;
    const boost = board.speed - normalSpeed;
    ball.vx += boost * nx;
    ball.vy += boost * ny;
    ball.vz += boost * nz;
  } else {
    if (normalSpeed >= 0) return null;
    const impulse = (1 + board.restitution) * normalSpeed;
    ball.vx -= impulse * nx;
    ball.vy -= impulse * ny;
    ball.vz -= impulse * nz;
  }
  const closest = {
    x: board.x + right.x * closestLocal.x + up.x * closestLocal.y + normal.x * closestLocal.z,
    y: board.y + right.y * closestLocal.x + up.y * closestLocal.y + normal.y * closestLocal.z,
    z: board.z + right.z * closestLocal.x + up.z * closestLocal.y + normal.z * closestLocal.z,
  };
  ball.x = closest.x + nx * BALL_RADIUS_WORLD;
  ball.y = closest.y + ny * BALL_RADIUS_WORLD;
  ball.z = closest.z + nz * BALL_RADIUS_WORLD;
  return {
    pieceId: board.id,
    kind: board.type,
    x: closest.x,
    y: closest.y,
    z: closest.z,
    speed: Math.abs(normalSpeed),
    normal: { x: nx, y: ny, z: nz },
    right: { ...right },
    up: { ...up },
  };
}

/** Advance capture timing and resolve any piece contacts for one substep. */
export function stepTrickShotPieces(ball, previous, pieces, runtime, dt) {
  tickCooldowns(runtime, dt);
  const held = holdOrLaunch(ball, pieces, runtime, dt);
  if (held) return held;

  for (const cannon of pieces) {
    if (cannon.type === CANNON_PIECE && catchWithCannon(ball, previous, cannon, runtime)) {
      return { contacts: ["sandbox-cannon-catch"], impacts: [], touched: [cannon.id], captured: true, launched: false };
    }
  }

  const contacts = [];
  const impacts = [];
  // WHICH tool was touched, not merely that one was. HORSE reads this to hold a
  // matcher to the tools the setter actually used, so a generic kind string is
  // not enough — two pads in a layout are two separate duties.
  const touched = [];
  for (const board of pieces) {
    if (!isPadPiece(board)) continue;
    const impact = resolvePad(ball, previous, board);
    if (!impact) continue;
    contacts.push(board.type === BOARD_PIECE ? "sandbox-board" : "sandbox-spring");
    impacts.push(impact);
    touched.push(board.id);
  }
  return { contacts, impacts, touched, captured: false, launched: false };
}
