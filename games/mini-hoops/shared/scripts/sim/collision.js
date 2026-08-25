// Every way the ball can hit something.
//
// Each resolver takes the ball and the world-space hoop, decides whether contact
// happened, and if so corrects the ball in place and reports what it hit. They
// know nothing about scoring, run state, messages or drawing — deciding what a
// contact *means* belongs to `shot.js`.
//
// Everything resolves against a MOVING hoop. The rim and backboard carry real
// world-space velocity in the moving modes, and the ball bounces off their
// relative motion, not off a stationary graphic that happens to be drawn
// somewhere else. A rim sweeping toward the ball genuinely throws it back
// harder, which is what makes the moving modes feel like they have a rim in them.

import {
  BALL_RADIUS_WORLD,
  BOARD_RESTITUTION,
  BOARD_Z,
  CEILING_RESTITUTION,
  CEILING_Y,
  FLOOR_RESTITUTION,
  RIM_FRICTION,
  RIM_RADIUS_WORLD,
  RIM_RESTITUTION,
  RIM_TUBE_RADIUS,
  WALL_RESTITUTION,
} from "./constants.js";

/** Contact kinds, as reported back to the shot lifecycle. */
/**
 * The reference flight, for a caller that has no ball in hand.
 *
 * The colliders stay PURE GEOMETRY — a rim does not care what hit it — so the
 * ball's character arrives as a plain block of multipliers rather than as a ball
 * id. Nothing here may import the ball catalog; `sim/physics.js` is the file
 * that knows which ball is in the air, and it is the one that passes this in.
 */
const NEUTRAL_FLIGHT = Object.freeze({ bounce: 1, grip: 1 });

/** Read one multiplier off a flight block, tolerating a missing or broken one. */
function factor(flight, key) {
  const value = flight && flight[key];
  return Number.isFinite(value) && value >= 0 ? value : 1;
}

/**
 * Restitution, scaled by the ball's own liveliness and capped at 1.
 *
 * The cap is not cosmetic: a coefficient above 1 is a surface that ADDS energy,
 * and a ball that left the floor faster than it arrived would bounce forever.
 * A ball authored too lively is clamped to perfectly elastic instead.
 */
function restitution(base, flight) {
  return Math.min(1, base * factor(flight, "bounce"));
}

export const CONTACT_RIM = "rim";
export const CONTACT_BACKBOARD = "backboard";
export const CONTACT_WALL = "wall";
export const CONTACT_CEILING = "ceiling";
export const CONTACT_FLOOR = "floor";

// How hard the ball has to be moving into the floor to bounce rather than settle.
const FLOOR_BOUNCE_THRESHOLD = 0.24;
// Speed scrubbed off on a floor bounce.
const FLOOR_TANGENT_KEEP_X = 0.76;
const FLOOR_TANGENT_KEEP_Z = 0.79;
// How fast the ball's spin converges on true rolling once it is on the floor.
const FLOOR_SPIN_BOUNCE_BLEND = 0.48;
const FLOOR_SPIN_ROLL_RATE = 12;
const FLOOR_SPIN_DECAY = 0.62;
const FLOOR_REST_DRAG_X = 0.18;
const FLOOR_REST_DRAG_Z = 0.25;
// How much of the ball's own spin the rim can re-write on a graze.
const RIM_SPIN_BLEND = 0.16;
// Board contact keeps most lateral motion; the rest is scrubbed into the board.
const BOARD_TANGENT_KEEP = 0.91;
const BOARD_SPIN_KEEP = 0.86;
const BOARD_SPIN_FROM_SLIDE = 0.045;
// Bare wall is dead by comparison — no bounce worth chasing.
const WALL_TANGENT_KEEP_X = 0.84;
const WALL_TANGENT_KEEP_Y = 0.8;
// The ceiling scrubs sideways and forward speed the way the wall does, but it
// keeps most of the ball's depth: a heave that clips the ceiling should still
// arrive at the wall, just lower and slower.
const CEILING_TANGENT_KEEP_X = 0.86;
const CEILING_TANGENT_KEEP_Z = 0.88;
// Nudge applied when un-penetrating, so the ball is not left exactly touching
// and immediately re-colliding on the next substep.
const SEPARATION_EPSILON = 0.0015;

/**
 * Rim contact, treated as a torus: a ring of radius RIM_RADIUS_WORLD made of
 * tube of radius RIM_TUBE_RADIUS.
 *
 * Modelling the ring properly rather than as a flat disc is what produces the
 * behaviour players read as "a real rim" — a shot can catch the near edge and
 * drop in, or clip the far edge and kick back out, and both fall out of the same
 * geometry instead of being special-cased.
 */
export function resolveRimContact(ball, hoopWorld, flight = NEUTRAL_FLIGHT) {
  // Nearest point on the ring's centre-line to the ball, found in the horizontal
  // plane the ring lies in.
  const dx = ball.x - hoopWorld.rimX;
  const dz = ball.z - hoopWorld.rimZ;
  const radial = Math.hypot(dx, dz);
  // Dead centre above the rim: no unique nearest point, and nothing to hit.
  if (radial < 1e-6) return null;

  const closestX = hoopWorld.rimX + (RIM_RADIUS_WORLD * dx) / radial;
  const closestZ = hoopWorld.rimZ + (RIM_RADIUS_WORLD * dz) / radial;

  let nx = ball.x - closestX;
  let ny = ball.y - hoopWorld.rimY;
  let nz = ball.z - closestZ;
  const distance = Math.hypot(nx, ny, nz);
  const contactRadius = BALL_RADIUS_WORLD + RIM_TUBE_RADIUS;
  if (distance >= contactRadius || distance < 1e-7) return null;

  nx /= distance;
  ny /= distance;
  nz /= distance;

  // Push out of the tube first, so the impulse below is applied from a clean
  // non-overlapping position.
  const penetration = contactRadius - distance + SEPARATION_EPSILON;
  ball.x += nx * penetration;
  ball.y += ny * penetration;
  ball.z += nz * penetration;

  // Work in the rim's frame of reference, then hand the rim's motion back.
  let rvx = ball.vx - hoopWorld.rimVx;
  let rvy = ball.vy - hoopWorld.rimVy;
  let rvz = ball.vz;

  const normalSpeed = rvx * nx + rvy * ny + rvz * nz;
  // Only resolve if the ball is actually moving *into* the rim. A ball already
  // separating has been handled and must not be bounced twice.
  if (normalSpeed < 0) {
    const bounce = restitution(RIM_RESTITUTION, flight);
    rvx -= (1 + bounce) * normalSpeed * nx;
    rvy -= (1 + bounce) * normalSpeed * ny;
    rvz -= (1 + bounce) * normalSpeed * nz;

    // Scrub a little tangential speed — the difference between a rattle that
    // settles and one that pinballs forever.
    // A grippier ball has more of its tangential speed scrubbed away, which is
    // what turns a rattle that would have kicked out into one that dies in the
    // ring. Clamped below 1 so grip can never reverse the tangent.
    const scrub = Math.min(0.95, RIM_FRICTION * factor(flight, "grip"));
    const postNormal = rvx * nx + rvy * ny + rvz * nz;
    const tx = (rvx - postNormal * nx) * (1 - scrub);
    const ty = (rvy - postNormal * ny) * (1 - scrub);
    const tz = (rvz - postNormal * nz) * (1 - scrub);

    ball.vx = postNormal * nx + tx + hoopWorld.rimVx;
    ball.vy = postNormal * ny + ty + hoopWorld.rimVy;
    ball.vz = postNormal * nz + tz;

    // The rim drags the ball's surface, so the graze re-writes some of its spin.
    const targetOmega = (postNormal * nz + tz) / BALL_RADIUS_WORLD;
    ball.omegaX += (targetOmega - ball.omegaX) * RIM_SPIN_BLEND;
  }

  return CONTACT_RIM;
}

/**
 * The wall plane at the back of the room, which is backboard where the board is
 * and bare wall everywhere else.
 *
 * `previousZ` is the ball's depth before this substep: contact is detected by the
 * ball having CROSSED the plane, not by it being near it, so a fast shot cannot
 * tunnel through the board between substeps.
 */
export function resolveBackWallContact(ball, previousZ, hoopWorld, boardBounds, flight = NEUTRAL_FLIGHT) {
  // Only a ball travelling toward the wall can hit it.
  if (ball.vz <= 0) return null;

  const contactZ = BOARD_Z - BALL_RADIUS_WORLD;
  const crossed = previousZ < contactZ && ball.z >= contactZ;
  if (!crossed) return null;

  // Bounds are grown by the ball's radius: a ball whose edge catches the corner
  // of the board has hit the board, not the wall behind it.
  const onBoard =
    ball.x >= boardBounds.minX - BALL_RADIUS_WORLD &&
    ball.x <= boardBounds.maxX + BALL_RADIUS_WORLD &&
    ball.y >= boardBounds.minY - BALL_RADIUS_WORLD &&
    ball.y <= boardBounds.maxY + BALL_RADIUS_WORLD;

  ball.z = contactZ - 0.001;

  if (onBoard) {
    ball.vz = -Math.abs(ball.vz) * restitution(BOARD_RESTITUTION, flight);
    // Lateral motion is kept relative to the moving board, so a bank off a
    // travelling backboard carries the board's drift.
    ball.vx = hoopWorld.boardVx + (ball.vx - hoopWorld.boardVx) * BOARD_TANGENT_KEEP;
    ball.vy = hoopWorld.boardVy + (ball.vy - hoopWorld.boardVy) * BOARD_TANGENT_KEEP;
    ball.omegaX = ball.omegaX * BOARD_SPIN_KEEP - ((ball.vy - hoopWorld.boardVy) / BALL_RADIUS_WORLD) * BOARD_SPIN_FROM_SLIDE;
    return CONTACT_BACKBOARD;
  }

  ball.vz = -Math.abs(ball.vz) * restitution(WALL_RESTITUTION, flight);
  ball.vx *= WALL_TANGENT_KEEP_X;
  ball.vy *= WALL_TANGENT_KEEP_Y;
  return CONTACT_WALL;
}

/**
 * The ceiling.
 *
 * The floor's mirror image, and much simpler than it: there is no settling case,
 * because nothing rests against a ceiling. It is checked on every substep rather
 * than only while the shot is live — a ball is inside the room whether or not it
 * has already scored.
 */
export function resolveCeilingContact(ball, flight = NEUTRAL_FLIGHT) {
  const contactY = CEILING_Y - BALL_RADIUS_WORLD;
  if (ball.y <= contactY) return null;

  ball.y = contactY - SEPARATION_EPSILON;
  ball.vy = -Math.abs(ball.vy) * restitution(CEILING_RESTITUTION, flight);
  ball.vx *= CEILING_TANGENT_KEEP_X;
  ball.vz *= CEILING_TANGENT_KEEP_Z;
  return CONTACT_CEILING;
}

/**
 * The floor.
 *
 * Above a threshold this is a bounce; below it the ball settles and starts
 * rolling, with its spin converging on true rolling motion so it does not slide
 * along visibly spinning the wrong way.
 */
export function resolveFloorContact(ball, dt, flight = NEUTRAL_FLIGHT) {
  if (ball.y >= BALL_RADIUS_WORLD) return null;
  ball.y = BALL_RADIUS_WORLD;

  if (Math.abs(ball.vy) > FLOOR_BOUNCE_THRESHOLD) {
    ball.vy = Math.abs(ball.vy) * restitution(FLOOR_RESTITUTION, flight);
    ball.vx *= FLOOR_TANGENT_KEEP_X;
    ball.vz *= FLOOR_TANGENT_KEEP_Z;
    ball.omegaX += (ball.vz / BALL_RADIUS_WORLD - ball.omegaX) * FLOOR_SPIN_BOUNCE_BLEND;
  } else {
    ball.vy = 0;
    // Frame-rate-independent drag: raising the keep-factor to the power of dt is
    // what makes a substepped tick decay by the same amount as a whole one.
    ball.vx *= Math.pow(FLOOR_REST_DRAG_X, dt);
    ball.vz *= Math.pow(FLOOR_REST_DRAG_Z, dt);
    ball.omegaX += (ball.vz / BALL_RADIUS_WORLD - ball.omegaX) * Math.min(1, dt * FLOOR_SPIN_ROLL_RATE);
    ball.omegaX *= Math.pow(FLOOR_SPIN_DECAY, dt);
  }

  return CONTACT_FLOOR;
}

/**
 * Did the ball just fall through the ring?
 *
 * Checked as a PLANE CROSSING rather than a proximity test. The ball can cover
 * more than its own diameter in a single substep, so "is it inside the ring right
 * now" would miss real makes depending on where the substep boundary happened to
 * fall. Instead: find the exact moment the ball's centre crossed the rim's height
 * and ask where it was at that instant.
 *
 * `previous` is the ball's position at the start of the substep.
 */
export function detectMadeBasket(ball, previous, hoopWorld) {
  // Must be descending, and must have crossed the rim's height this substep.
  if (ball.vy >= 0) return false;
  if (previous.y <= hoopWorld.rimY || ball.y > hoopWorld.rimY) return false;

  const drop = previous.y - ball.y;
  if (drop <= 1e-7) return false;

  const t = (previous.y - hoopWorld.rimY) / drop;
  const crossX = previous.x + (ball.x - previous.x) * t;
  const crossZ = previous.z + (ball.z - previous.z) * t;

  // The ball's centre has to be inside the ring by enough that the ball's *body*
  // fits — clearing the tube, not just the centre-line.
  const radial = Math.hypot(crossX - hoopWorld.rimX, crossZ - hoopWorld.rimZ);
  const cleanRadius = RIM_RADIUS_WORLD - BALL_RADIUS_WORLD - RIM_TUBE_RADIUS * 0.55;
  return radial < cleanRadius;
}

/**
 * What a made basket does to the ball.
 *
 * The net is not simulated; this stands in for it. It kills most of the forward
 * momentum and commits the ball to dropping through, so a made shot cannot
 * carry on and clip the rim on its way out and look like it came back.
 */
export function applyNetDrag(ball, hoopWorld) {
  ball.vx = hoopWorld.rimVx + (ball.vx - hoopWorld.rimVx) * 0.52;
  ball.vy = Math.min(ball.vy, -0.75);
  ball.vz = -Math.abs(ball.vz) * 0.1;
  ball.z = Math.min(ball.z, hoopWorld.rimZ + 0.07);
}
