// Replays one HORSE shot through a mirrored copy of the cabinet's own sim.
//
// Same rule as `mini-hoops-adjudicator.mjs`: no outcome supplied by a browser
// participates in this ruling. The client sends a pull and the phase of the
// bin's motion clock it released on — nothing about whether it went in.
//
// THE MOTION CLOCK IS THE CLIENT'S TO CHOOSE, and that is not a hole. A player
// may stand and watch a moving bin for as long as they like before releasing,
// so every phase of the path is legitimately reachable; picking the moment IS
// the skill the motions exist to ask for. It is clamped only to keep the replay
// bounded.
import { ballById, ballFlight } from "../shared/scripts/assets/ball-catalog.js";
import { TICK_SECONDS } from "../shared/scripts/sim/constants.js";
import { placedBinAt } from "../shared/scripts/sim/bin-placement.js";
import { stepBallAgainstBins } from "../shared/scripts/sim/bin-physics.js";
import { createHorseShot } from "../shared/scripts/sim/horse-shot.js";
import { createBall, isBallSettled, launchBall } from "../shared/scripts/sim/physics.js";

// The cabinet's own two give-up rules, and they are load-bearing rather than
// tidy: `scripts/horse-game.js` calls a shot dead on exactly these, so a server
// that waited longer would rule on a ball the player had already seen come to
// rest.
const FLIGHT_TIMEOUT_SECONDS = 3.4;
const SETTLE_AFTER_SECONDS = 0.45;
const MAX_TICKS = Math.ceil((FLIGHT_TIMEOUT_SECONDS + 1) / TICK_SECONDS);

export function adjudicateHorseShot({ intent, setup, motionSeconds = 0 }) {
  const ballId = ballById(intent.ballId).id;
  const ball = createBall();
  const shot = createHorseShot(
    { power: intent.power, aimX: intent.aimX, loft: intent.loft },
    ball,
    setup,
    { weight: ballFlight(ballId).weight },
  );
  launchBall(ball, shot.launch);

  const contacts = [];
  let captured = null;
  // The bin's clock advances BEFORE the step, because the cabinet's tick does:
  // `turnClock += TICK_SECONDS` runs at the top of `tick()` and the flight is
  // stepped against `placedBinAt(setup, turnClock)` underneath it. A half-tick
  // of disagreement here is a made basket that only one of the two machines saw.
  let clock = Math.max(0, Number(motionSeconds) || 0);
  let age = 0;

  for (let tick = 0; tick < MAX_TICKS; tick += 1) {
    clock += TICK_SECONDS;
    age += TICK_SECONDS;
    const bin = placedBinAt(setup, clock);
    const stepped = stepBallAgainstBins(ball, [bin], TICK_SECONDS, {
      ballId,
      capturedBin: captured,
    });
    contacts.push(...stepped.contacts);
    if (stepped.capturedBin !== null) captured = stepped.capturedBin;
    if (stepped.scoredBin !== null) return { made: true, contacts: [...new Set(contacts)] };
    if (age > FLIGHT_TIMEOUT_SECONDS || (age > SETTLE_AFTER_SECONDS && isBallSettled(ball))) break;
  }
  return { made: false, contacts: [...new Set(contacts)] };
}
