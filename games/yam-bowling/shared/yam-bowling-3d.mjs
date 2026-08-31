import * as physics from './yam-bowling-physics.mjs';
import { create3dPhysics } from './bowl3d/physics.mjs';

// The pinned cabinet engine is also the authority. Never accept pin counts,
// transforms or fall times from a client: the wire contains only shot inputs.
const engine = create3dPhysics(physics);
export const clear3dFallen = engine.clearFallen;
function simulationJob(pins, declaredShot) {
  const shot = { ...declaredShot, ...physics.YAM_BALL_PROFILES[declaredShot.ballIndex] };
  const sim = engine.createSimulation(pins, shot);
  const fallen = new Set(), pinFalls = [];
  let steps = 0;
  return {
    advance() {
      for (let batch = 0; batch < 12 && !sim.complete; batch++) {
        if (++steps > 5400) throw new Error('3D roll exceeded its simulation budget');
        engine.stepSimulation(sim, 1 / 180);
        for (const pin of sim.pins) {
          if (!pin.standing && !fallen.has(pin.id)) {
            fallen.add(pin.id);
            pinFalls.push({ id: pin.id, time: sim.elapsed });
          }
        }
      }
      return sim.complete;
    },
    result: () => ({ pins: sim.pins, knocked: engine.knockedCount(sim), pinFalls, duration: sim.elapsed }),
  };
}
export function simulate3dShot(pins, shot) {
  const job = simulationJob(pins, shot);
  while (!job.advance()) { /* Bounded synchronous runner for deterministic tests. */ }
  return job.result();
}
export async function simulate3dShotAsync(pins, shot) {
  const job = simulationJob(pins, shot);
  while (!job.advance()) await new Promise(resolve => setImmediate(resolve));
  return job.result();
}
