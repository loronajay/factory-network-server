// The Pondside Push CPU: it holds a direction and presses bump, like anybody.
//
// A bump is only worth something with pace behind it, so the CPU plays the
// game the way a person learns to: take a run-up, come at a pet from the
// inside (a push from the middle sends it toward the water), sidestep a pet
// charging at you, and never loiter at the rim.
//
// Difficulty is hands, never a stronger pet:
//  - rim: how near the edge (share of the island's radius) it lets itself get before backing off
//  - aim: how far its heading drifts off the line it wants (radians)
//  - lined: how well it must be pointed at a pet before it commits a bump
//  - reach: from how far it swings
//  - runUp: the pace it wants under it before it bumps
//  - retreat: how many ticks it backs off for when it finds itself stuck against a pet with no pace
//  - dodge: the chance it sidesteps a charge it sees coming
//  - inside: how hard it works to get between a pet and the middle before charging
//  - hesitate: the chance, per third of a second, that it freezes
// Every CPU grows bolder as a round runs on, so a stand-off always breaks.
// Imperfection comes from `noise(seed, ...)`: deterministic, so a match
// replays identically on the server and in tests.

import { noise } from "../../../pet-games/shared/sim/rivals.js?v=20260928-pet-online";

export const CPU_KNOBS = Object.freeze({
  rookie: Object.freeze({ rim: 0.82, aim: 0.6, lined: 0.5, reach: 70, runUp: 60, retreat: 8, dodge: 0.08, inside: 0.1, hesitate: 0.32 }),
  pro: Object.freeze({ rim: 0.74, aim: 0.2, lined: 0.6, reach: 90, runUp: 100, retreat: 30, dodge: 0.4, inside: 0.35, hesitate: 0.06 }),
  champion: Object.freeze({ rim: 0.7, aim: 0.06, lined: 0.72, reach: 90, runUp: 120, retreat: 36, dodge: 0.6, inside: 0.5, hesitate: 0.01 }),
});

export function cpuKnobs(level) {
  return CPU_KNOBS[level] ?? CPU_KNOBS.pro;
}

const normalize = (x, y) => {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
};

function rotate(vector, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: vector.x * cos - vector.y * sin, y: vector.x * sin + vector.y * cos };
}

/**
 * Controls for one CPU pet this tick. `options.level` picks its hands,
 * `options.seed` its luck, `options.islandRadius` the island as it stands now
 * and `options.roundSeconds` how long this round has run. `options.memory` is
 * this CPU's own small scratch object (the session keeps one per CPU seat).
 */
export function cpuControls(actor, players, tick, options = {}) {
  const knobs = cpuKnobs(options.level);
  const seed = options.seed ?? 0;
  const island = Number(options.islandRadius) || 260;
  const boldness = Math.min(1, Math.max(0, Number(options.roundSeconds ?? tick / 60) || 0) / 20);
  const beat = Math.floor(tick / 20);
  const rimDistance = Math.hypot(actor.x, actor.y);
  const speed = Math.hypot(actor.vx ?? 0, actor.vy ?? 0);
  const opponents = players.filter((player) => player.id !== actor.id && !player.eliminated);
  const inward = normalize(-actor.x, -actor.y);

  if (noise(seed, actor.id, "hesitate", beat) < knobs.hesitate * (1 - boldness)) return { x: 0, y: 0, bump: false };
  if (rimDistance > island * knobs.rim) return { ...inward, bump: false };

  // A pet charging straight at me: step aside, toward the middle rather than the water.
  const threat = opponents.find((player) => {
    const dx = actor.x - player.x;
    const dy = actor.y - player.y;
    const distance = Math.hypot(dx, dy);
    const closing = ((player.vx ?? 0) * dx + (player.vy ?? 0) * dy) / (distance || 1);
    return distance < 120 && closing > 150;
  });
  if (threat && noise(seed, actor.id, "dodge", threat.id, beat) < knobs.dodge) {
    const away = normalize(actor.x - threat.x, actor.y - threat.y);
    const sides = [{ x: -away.y, y: away.x }, { x: away.y, y: -away.x }];
    const side = sides[0].x * inward.x + sides[0].y * inward.y >= 0 ? sides[0] : sides[1];
    return { ...side, bump: false };
  }

  // The best target is near, and near the water; ties by id so every copy of the match agrees.
  const score = (player) => Math.hypot(player.x - actor.x, player.y - actor.y) - Math.hypot(player.x, player.y) * 0.6;
  const target = [...opponents].sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id))[0];
  if (!target) return { x: 0, y: 0, bump: false };

  const distance = Math.hypot(target.x - actor.x, target.y - actor.y);
  const targetRim = Math.hypot(target.x, target.y);
  const outward = targetRim > 1 ? normalize(target.x, target.y) : normalize(target.x - actor.x, target.y - actor.y);
  const toTarget = normalize(target.x - actor.x, target.y - actor.y);
  const flank = actor.id < target.id ? 1 : -1;
  const runUp = knobs.runUp * (1 - boldness * 0.6);
  const nearWater = targetRim > island * 0.62;

  // Stuck against a pet with no pace: back off toward the middle for long enough to take a run-up.
  const memory = options.memory ?? {};
  if (distance < 75 && speed < Math.min(70, runUp) && !nearWater && !(memory.retreatUntil > tick)) {
    memory.retreatUntil = tick + knobs.retreat;
  }
  let aimPoint = target;
  if (memory.retreatUntil > tick && !nearWater) {
    aimPoint = { x: actor.x - toTarget.x * 60 + inward.x * 40 + toTarget.y * 30 * flank, y: actor.y - toTarget.y * 60 + inward.y * 40 - toTarget.x * 30 * flank };
  } else if (rimDistance > targetRim - 12 && noise(seed, actor.id, "inside", beat) < knobs.inside * (1 - boldness)) {
    // Outside the target: work round to the inside of it before charging.
    aimPoint = { x: target.x - outward.x * 70 - outward.y * 25 * flank, y: target.y - outward.y * 70 + outward.x * 25 * flank };
  }

  const wobble = (noise(seed, actor.id, "aim", beat) - 0.5) * 2 * knobs.aim;
  const aim = rotate(normalize(aimPoint.x - actor.x, aimPoint.y - actor.y), wobble);
  const lined = toTarget.x * actor.facingX + toTarget.y * actor.facingY;
  const bump = actor.bumpCooldown <= 0
    && distance < knobs.reach
    && lined > knobs.lined
    && (speed >= runUp || nearWater);
  return { ...aim, bump };
}
