import { ballFlight } from "../shared/scripts/assets/ball-catalog.js";
import { TICK_SECONDS } from "../shared/scripts/sim/constants.js";
import { hoopAt } from "../shared/scripts/sim/hoop.js";
import { solveLaunch } from "../shared/scripts/sim/launch.js";
import { createBall, isBallSettled, launchBall, stepBall, worldFor } from "../shared/scripts/sim/physics.js";
import { SHOT_FLIGHT, advanceShot, beginShot, createShot } from "../shared/scripts/sim/shot.js";

const MAX_TICKS = Math.ceil(12 / TICK_SECONDS);

// Replays one normalized pull through the cabinet's mirrored fixed-timestep sim.
// No score, outcome or clock supplied by a browser participates in this ruling.
export function adjudicateMiniHoopsShot({ intent, config, motionSeconds }) {
  const ball = createBall();
  let shot = createShot();
  const launch = solveLaunch({
    origin: { x: ball.x, y: ball.y, z: ball.z },
    aim: { x: intent.aimX, y: intent.aimY },
    power: intent.power,
    loft: intent.loft,
    weight: ballFlight(config.ballId).weight,
  });
  launchBall(ball, launch);
  beginShot(shot);
  const contacts = [];

  for (let tick = 0; tick < MAX_TICKS && shot.state === SHOT_FLIGHT; tick += 1) {
    const hoop = hoopAt(config.modeId, motionSeconds + tick * TICK_SECONDS);
    const world = worldFor(hoop);
    const stepped = stepBall(ball, world, TICK_SECONDS, {
      ballId: config.ballId,
      alreadyScored: shot.scored,
    });
    contacts.push(...stepped.contacts);
    advanceShot(shot, {
      ball,
      hoop,
      hoopWorld: world.hoopWorld,
      contacts: stepped.contacts,
      scored: shot.scored,
      settled: isBallSettled(ball),
    }, TICK_SECONDS);
  }

  return { scored: shot.scored, contacts: [...new Set(contacts)] };
}
