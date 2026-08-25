// The integrator: advances the ball and runs the colliders in the right order.
//
// This file owns *when* things are checked, `collision.js` owns *how* each one
// resolves, and `shot.js` owns what any of it means. Keeping the ordering here
// and alone matters, because the order is load-bearing:
//
//   1. Integrate.
//   2. Did it go in? — asked FIRST, so a clean make is never stolen by the rim
//      resolver nudging the ball a fraction out of the ring.
//   3. Rim, then back wall — only if it did not go in.
//   4. Floor, always.
//
// A SPLATTING BALL IS STOPPED HERE AND NOWHERE ELSE. The colliders stay pure
// geometry — a rim does not care what hit it — so the one thing that knows the
// snowball does not come back off a wall is this file, which is already the
// file that knows which ball is in the air.
//
// THE BALL'S FLIGHT IS APPLIED HERE, for the same reason. This file resolves the
// ball id into a flight block once per tick and spends it two ways: gravity and
// air drag are integrated here, and `bounce`/`grip` are handed down to the
// colliders as plain multipliers. The colliders never learn what a ball is.
//
// Weight is deliberately NOT a surprise: `sim/launch.js` solved the shot against
// this same multiplier, so a heavy ball still swishes at the reference pull and
// only its arc changes. Drag is the one the solver was not told about, so it is
// the one the player feels as the ball landing short.
//
// A tick is integrated in substeps (PHYSICS_SUBSTEP_SECONDS). At full speed the
// ball crosses the whole rim in well under a 60Hz tick, so a single-step
// integration would let it teleport past the ring and turn a made basket into a
// coin flip on frame phase.

import { ballFlight, ballSplatsOn, rollPhasePerRadian } from "../assets/ball-catalog.js";
import {
  BALL_RADIUS_WORLD,
  GRAVITY,
  PHYSICS_SUBSTEP_SECONDS,
  SPIN_DECAY_PER_TICK,
} from "./constants.js";
import {
  applyNetDrag,
  detectMadeBasket,
  resolveBackWallContact,
  resolveCeilingContact,
  resolveFloorContact,
  resolveRimContact,
} from "./collision.js";
import { boardWorldBounds, hoopWorldState } from "./hoop.js";

/** A ball at rest in the shooter's hands. */
export function createBall() {
  return {
    x: 0,
    y: 0.1,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    // Angular velocity about the screen-horizontal axis, radians/second.
    omegaX: 0,
    // Where this ball burst, once it has: `{ surface, x, y, z, speed }`, or
    // null. A ball with one set never moves again — see `stickBall`.
    splat: null,
    // Continuous frame position, accumulated from omegaX. Fractional, and
    // negative when the ball rolls backward.
    rollPhase: 0,
  };
}

/** Return a ball to the shooting position, in place. */
export function resetBall(ball) {
  Object.assign(ball, createBall());
}

/** Launch the ball with a solved velocity and spin. */
export function launchBall(ball, launch, spin) {
  ball.vx = launch.vx;
  ball.vy = launch.vy;
  ball.vz = launch.vz;
  ball.omegaX = spin;
}

/**
 * The world the ball is being stepped against, derived once per tick.
 *
 * Deriving it once and reusing it across every substep is deliberate: within a
 * single tick the hoop is treated as moving at a constant velocity, which keeps
 * the substeps consistent with each other.
 */
export function worldFor(hoop) {
  return {
    hoopWorld: hoopWorldState(hoop),
    boardBounds: boardWorldBounds(hoop),
  };
}

/**
 * Advance the ball by one fixed tick.
 *
 * Mutates `ball` in place and returns what happened. `alreadyScored` suppresses
 * the hoop colliders for a ball that is already dropping through the net.
 *
 * @returns `{ contacts, scored }` — `contacts` in the order they occurred.
 */
export function stepBall(ball, world, tickSeconds, { ballId, alreadyScored = false } = {}) {
  // A ball that has already burst is stuck to whatever it hit. Nothing moves it
  // again and nothing else can happen to it; the shot above still runs out its
  // normal beat before handing a fresh ball back.
  if (ball.splat) return { contacts: [], scored: false, splat: null };

  const substeps = Math.max(1, Math.ceil(tickSeconds / PHYSICS_SUBSTEP_SECONDS));
  const dt = tickSeconds / substeps;
  const phasePerRadian = rollPhasePerRadian(ballId);
  // Resolved once per tick, not per substep: it is pure data and cannot change
  // mid-flight, and the lookup is a linear scan of the catalog.
  const flight = ballFlight(ballId);
  const gravity = GRAVITY * flight.weight;
  // Frame-rate-independent air drag, the same trick the floor's rolling drag
  // uses: raising a per-second keep-factor to the power of dt makes a substepped
  // tick decay by exactly as much as a whole one would have.
  const dragKeep = flight.drag > 0 ? Math.exp(-flight.drag * dt) : 1;

  const contacts = [];
  let scored = false;
  let splat = null;

  for (let step = 0; step < substeps && !splat; step++) {
    const previous = { x: ball.x, y: ball.y, z: ball.z };
    // This substep's own contacts, kept separately so the splat check below can
    // ask what just happened rather than what has happened all tick.
    const hits = [];

    ball.vy -= gravity * dt;
    // Drag acts on the whole velocity, so it shortens the throw AND caps the
    // fall. Applied before the position update, so the step the ball takes is
    // the speed it actually has.
    if (dragKeep !== 1) {
      ball.vx *= dragKeep;
      ball.vy *= dragKeep;
      ball.vz *= dragKeep;
    }
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.z += ball.vz * dt;

    // Spin bleeds off slowly, and drives the animation frame. Raising the decay
    // to dt*60 keeps it identical whatever the substep count works out to.
    ball.omegaX *= Math.pow(SPIN_DECAY_PER_TICK, dt * 60);
    ball.rollPhase += ball.omegaX * dt * phasePerRadian;

    if (!alreadyScored && !scored) {
      if (detectMadeBasket(ball, previous, world.hoopWorld)) {
        scored = true;
        applyNetDrag(ball, world.hoopWorld);
        hits.push("score");
      } else {
        // Rim and back wall are checked independently, not as alternatives: a
        // ball can clip the ring and still cross the board plane inside the same
        // substep, and collapsing that into one contact loses the second bounce.
        const rim = resolveRimContact(ball, world.hoopWorld, flight);
        if (rim) hits.push(rim);
        const wall = resolveBackWallContact(ball, previous.z, world.hoopWorld, world.boardBounds, flight);
        if (wall) hits.push(wall);
      }
    }

    // Both horizontal planes are checked outside the scoring branch above: the
    // room contains the ball whether or not the shot has already resolved.
    const ceiling = resolveCeilingContact(ball, flight);
    if (ceiling) hits.push(ceiling);
    const floor = resolveFloorContact(ball, dt, flight);
    if (floor) hits.push(floor);

    for (const hit of hits) contacts.push(hit);

    // The collider has already corrected the ball onto the surface and bounced
    // it off. For a ball that does not come back off, the bounce is undone: the
    // corrected POSITION is exactly where the splat belongs, and the velocity
    // it was given is exactly what it must not keep.
    const burst = hits.find((hit) => ballSplatsOn(ballId, hit));
    if (burst) splat = stickBall(ball, burst);
  }

  return { contacts, scored, splat };
}

/**
 * Stop a ball dead where it stands, and report the splat.
 *
 * `speed` is read BEFORE the velocity is thrown away, because how hard it hit
 * is the only thing left to scale the burst and the sound by once it has.
 */
function stickBall(ball, surface) {
  const speed = Math.hypot(ball.vx, ball.vy, ball.vz);
  ball.vx = 0;
  ball.vy = 0;
  ball.vz = 0;
  ball.omegaX = 0;
  ball.splat = { surface, x: ball.x, y: ball.y, z: ball.z, speed };
  return ball.splat;
}

/** Whether the ball has come to rest on the floor and is done being interesting. */
export function isBallSettled(ball) {
  // A splatted ball is as at-rest as a ball gets, and is still deliberately not
  // reported as settled. `settled` is the flag that hands the ball back EARLY,
  // and a ball whose dead shots ended sooner than every other ball's would fit
  // more attempts into a 30-second round — which a board keyed on
  // `mode:duration` alone cannot survive. The splat is what the player sees;
  // the shot still runs the same beat it would have. See `assets/ball-catalog.js`.
  if (ball.splat) return false;

  return (
    ball.z < 0.92 &&
    ball.y <= BALL_RADIUS_WORLD + 0.015 &&
    Math.abs(ball.vy) < 0.08 &&
    Math.abs(ball.vz) < 0.08
  );
}
