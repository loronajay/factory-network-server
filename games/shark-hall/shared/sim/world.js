// The table as a running object: balls, the fixed timestep, and the record of
// what one shot did.
//
// This is the seam the rest of the cabinet hangs off. Above it, `match/` asks
// the rules what a shot meant; beside it, `render/` mirrors the ball positions
// and `audio/` listens to the events; below it, `physics.js` does the maths.
// None of those three know about each other.
//
// Pure. No THREE, no DOM, and — deliberately — NO CLOCK. The settle window is
// counted in accumulated simulated seconds rather than read off
// `performance.now()`, so a test can run a whole shot to completion in a loop
// and get the same answer the browser gets in real time. That is also what a
// server would need to mirror it.
//
// THE TIMESTEP IS FIXED, per the repo rule. 240hz substeps, drained from an
// accumulator, so the break resolves identically at 60hz and at 144hz.

import { SETTLE_MS, SIM_STEP, REST_SPEED } from "./constants.js";
import { CUE, cloneBalls, cueBall, rackBalls, speedOf, stillBall } from "./balls.js";
import { applyClothFriction, collideAll, collideRails } from "./physics.js";
import { captureHangingBalls, findPocket, pocketBall } from "./pockets.js";
import { strikeCue } from "./shot.js";

const SETTLE_SECONDS = SETTLE_MS / 1000;
/** Hard ceiling on substeps per frame, so a stalled tab cannot spiral. */
const MAX_SUBSTEPS = 14;

export function createWorld() {
  let balls = rackBalls();
  let moving = false;
  let accumulator = 0;
  let stillFor = 0;

  /** What the shot in progress has done so far. Reset by `strike`. */
  let report = emptyReport();

  /** Contacts since the last drain. The caller empties it; nothing here reads it. */
  let events = [];

  function emptyReport() {
    return { pocketed: [], firstHit: null, cushionAfterContact: false };
  }

  /** One 240hz substep: integrate, bounce, drop, then bleed off energy. */
  function substep(dt) {
    for (const ball of balls) {
      if (ball.pocketed) continue;
      ball.x += ball.vx * dt;
      ball.z += ball.vz * dt;

      // Only rails struck AFTER first contact count toward the table-scratch
      // rule, so the flag is set here rather than inside the collider.
      const railContacts = collideRails(ball, events);
      if (railContacts > 0 && report.firstHit !== null) report.cushionAfterContact = true;

      const pocket = findPocket(ball);
      if (pocket) {
        // Read the speed before pocketing it, because dropping a ball stops it
        // and the audio wants to know how hard it arrived.
        const arrival = speedOf(ball);
        if (pocketBall(ball)) {
          report.pocketed.push(ball.n);
          events.push({ type: "pocket", n: ball.n, pocket: pocket.id, speed: arrival });
        }
      }
    }

    const firstContact = collideAll(balls, events);
    if (report.firstHit === null && firstContact !== null) report.firstHit = firstContact;

    for (const ball of balls) if (!ball.pocketed) applyClothFriction(ball, dt);
  }

  const everythingStopped = () => balls.every((ball) => ball.pocketed || speedOf(ball) < REST_SPEED);

  return {
    /** The live ball array. Read freely; write only through this object. */
    get balls() {
      return balls;
    },

    get moving() {
      return moving;
    },

    /** The shot in progress, or the last one that finished. */
    get report() {
      return report;
    },

    cue: () => cueBall(balls),

    /** A fresh rack. Everything about the shot in progress is discarded. */
    rack() {
      balls = rackBalls();
      moving = false;
      accumulator = 0;
      stillFor = 0;
      report = emptyReport();
      events = [];
      return balls;
    },

    /**
     * Adopt a table from outside.
     *
     * The counterpart of `rack`, and the reason this world can be driven by
     * something other than itself: an authoritative table arrives as fifteen
     * plain objects and is taken up whole, with the shot in progress discarded.
     * The copy is deliberate — the caller keeps its own array and neither side
     * can write through the other. Every online shot on this cabinet starts
     * here, on both the server that scores it and the client that draws it.
     */
    load(next) {
      balls = cloneBalls(next);
      moving = false;
      accumulator = 0;
      stillFor = 0;
      report = emptyReport();
      events = [];
      return balls;
    },

    /**
     * Put the cue ball down. Callers must have checked legality first —
     * `placement.js` owns that question and this owns the table.
     */
    placeCue(x, z) {
      const cue = cueBall(balls);
      if (!cue) return false;
      cue.pocketed = false;
      cue.x = x;
      cue.z = z;
      stillBall(cue);
      return true;
    },

    /** Strike the cue ball and begin a shot. Returns the shot that was played. */
    strike(stroke) {
      const cue = cueBall(balls);
      if (!cue || moving) return null;
      report = emptyReport();
      events = [];
      accumulator = 0;
      stillFor = 0;
      moving = true;
      const shot = strikeCue(cue, stroke);
      events.push({ type: "strike", n: CUE, speed: shot.speed, power: shot.power });
      return shot;
    },

    /**
     * Advance by a frame's worth of real time.
     *
     * @returns `{ settled, events }`. `settled` is true on the ONE frame the
     *   shot finished — the caller scores it then, and only then.
     */
    step(dt) {
      if (!moving) return { settled: false, events: drain() };

      accumulator += dt;
      let loops = 0;
      while (accumulator >= SIM_STEP && loops < MAX_SUBSTEPS) {
        substep(SIM_STEP);
        accumulator -= SIM_STEP;
        loops++;
      }

      let settled = false;
      if (everythingStopped()) {
        stillFor += dt;
        // A ball balanced on a lip drops during this window; taking it here is
        // what makes the wait worth having.
        for (const { ball, pocket } of captureHangingBalls(balls)) {
          report.pocketed.push(ball.n);
          events.push({ type: "pocket", n: ball.n, pocket: pocket.id, speed: 0, hanging: true });
        }
        if (stillFor >= SETTLE_SECONDS) {
          moving = false;
          stillFor = 0;
          settled = true;
        }
      } else {
        stillFor = 0;
      }

      return { settled, events: drain() };
    },
  };

  function drain() {
    const drained = events;
    events = [];
    return drained;
  }
}
