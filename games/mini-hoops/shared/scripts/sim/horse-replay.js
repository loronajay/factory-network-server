// Play one HORSE shot out, headless, and say what it did.
//
// This is the cabinet's flight loop with the browser taken off it: no canvas, no
// audio, no splats, no effects — a pull goes in and `{ made, contacts, touched }`
// comes out. It exists because the answer is needed away from a court:
//
//   `factory-network-server`'s HORSE adjudicator rules on every online shot, and
//   used to carry its own copy of this loop — which is a second statement of the
//   one thing that must not differ between the two machines;
//   and the tools sweep thousands of pulls looking for a make, which is how a
//   legal placement nobody could convert gets found.
//
// `scripts/horse-game.js` deliberately still owns its own loop, because that one
// is doing a different job: it draws, it sounds, it sheds fire and it hands the
// ball back a beat later. What it must not do is DISAGREE, so the two give-up
// rules below are the cabinet's own and the ordering here is the cabinet's own —
// the target's clock advances before the step, exactly one integrator runs per
// substep, and the piece step runs after it on the same substep.
//
// TOUCH IS RECORDED ONLY UNTIL THE SHOT SCORES, which reads like an accident and
// is not. A ball that has already dropped through can still clip a pad on its way
// down, and counting that would credit a matcher with a tool they hit AFTER the
// shot was over. The court's copy is gated the same way for the same reason.

import { ballById, ballFlight } from "../assets/ball-catalog.js";
import { PHYSICS_SUBSTEP_SECONDS, TICK_SECONDS } from "./constants.js";
import { stepBallAgainstBins } from "./bin-physics.js";
import { createHorseShot, horseTargetAt } from "./horse-shot.js";
import { createBall, isBallSettled, launchBall, stepBall, worldFor } from "./physics.js";
import { createTrickShotPhysics, stepTrickShotPieces } from "./trick-shot-physics.js";

// The cabinet's own two give-up rules, and they are load-bearing rather than
// tidy: `scripts/horse-game.js` calls a shot dead on exactly these, so a replay
// that waited longer would rule on a ball the player had already seen come to
// rest.
export const FLIGHT_TIMEOUT_SECONDS = 7;
export const SETTLE_AFTER_SECONDS = 0.45;

/**
 * Replay one shot at one target.
 *
 * @param setup         the target — kind, motion, placement, and any tools.
 * @param intent        the pull: `{ power, aimX, loft }`.
 * @param motionSeconds the phase of the target's motion clock at release.
 * @param maxSeconds    a shorter budget than the cabinet's, for callers that
 *                      are sweeping and would rather abandon a lob than watch
 *                      it out. Defaults to the real one.
 * @param trace         when set, every substep position is recorded. Off by
 *                      default: the planner wants a path, an adjudicator wants
 *                      a verdict, and allocating a few hundred points per
 *                      replay would be paid for by the one that does not.
 */
export function replayHorseShot({
  setup,
  intent,
  motionSeconds = 0,
  maxSeconds = FLIGHT_TIMEOUT_SECONDS,
  trace = false,
} = {}) {
  const ballId = ballById(intent?.ballId).id;
  const ball = createBall();
  const shot = createHorseShot(
    { power: intent?.power, aimX: intent?.aimX, loft: intent?.loft },
    ball,
    setup,
    { weight: ballFlight(ballId).weight },
  );
  launchBall(ball, shot.launch);

  const pieces = Array.isArray(setup?.pieces) ? setup.pieces : [];
  const runtime = createTrickShotPhysics();
  const contacts = [];
  const touched = [];
  const path = trace ? [] : null;
  let captured = null;
  let made = false;
  let clock = Math.max(0, Number(motionSeconds) || 0);
  let age = 0;
  const maxTicks = Math.ceil((Math.max(0.1, maxSeconds) + 1) / TICK_SECONDS);

  for (let tick = 0; tick < maxTicks && !made; tick += 1) {
    clock += TICK_SECONDS;
    age += TICK_SECONDS;
    const target = horseTargetAt(setup, clock);
    const world = target.hoop ? worldFor(target.hoop) : null;
    const substeps = Math.max(1, Math.ceil(TICK_SECONDS / PHYSICS_SUBSTEP_SECONDS));
    const dt = TICK_SECONDS / substeps;
    for (let index = 0; index < substeps; index += 1) {
      const previous = { x: ball.x, y: ball.y, z: ball.z };
      if (!runtime.capture) {
        const stepped = world
          ? stepBall(ball, world, dt, { ballId, alreadyScored: false })
          : stepBallAgainstBins(ball, [target.bin], dt, { ballId, capturedBin: captured });
        contacts.push(...stepped.contacts);
        if (!world && stepped.capturedBin !== null) captured = stepped.capturedBin;
        if (world ? stepped.scored : stepped.scoredBin !== null) {
          made = true;
          break;
        }
      }
      if (!ball.splat && captured === null) {
        const step = stepTrickShotPieces(ball, previous, pieces, runtime, dt);
        contacts.push(...step.contacts);
        touched.push(...(step.touched || []));
      }
      if (path) path.push({ x: ball.x, y: ball.y, z: ball.z, vx: ball.vx, vy: ball.vy, vz: ball.vz, t: age });
    }
    if (age > maxSeconds || (!runtime.capture && age > SETTLE_AFTER_SECONDS && isBallSettled(ball))) break;
  }

  return {
    made,
    seconds: age,
    contacts: [...new Set(contacts)],
    touched: [...new Set(touched)],
    path,
  };
}
