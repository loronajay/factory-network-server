// The CPU driver: it presses the same five buttons a player does.
//
// A CPU racer has no other path into the race — `race.js` asks this module for
// controls and hands them to the same `advanceRacer` a person's keys reach —
// so a rival is bound by the player's physics and cannot be given a faster
// pet by difficulty. Difficulty is HANDS: how far ahead it reads the road, how
// cleanly it holds a line, how well it times a jump, whether it sees mud
// coming. Every bit of imperfection comes from `noise(seed, ...)`, never from
// Math.random, so a race replays identically on the server and in tests.

import { noise } from "../../../pet-games/shared/sim/rivals.js?v=20260928-pet-online";
import { closestPointOnRoad, pointAtStation, pointInRect, roadLength, roadStation } from "./track.js?v=20260928-pet-online";

/**
 * What each level means, in hands.
 *  - lookahead: seconds of road the driver aims down (more = smoother, cuts corners)
 *  - line: how hard it takes the inside of a bend (0 = centre line)
 *  - wobble: lateral drift of its line, as a fraction of half the road
 *  - deadband: how far off-heading it lets itself get before correcting (radians)
 *  - jumpLead / jumpJitter: where it jumps a hurdle, in units before it, and how much that varies
 *  - jumpMiss: the chance it simply mistimes a hurdle and runs into it
 *  - lift: the chance, per half second, that it lifts off the throttle for a moment
 *  - mudAvoid: whether it steers round a wallow it can see coming
 */
export const CPU_KNOBS = Object.freeze({
  rookie: Object.freeze({ lookahead: 0.34, line: 0, wobble: 0.34, deadband: 0.12, jumpLead: 62, jumpJitter: 46, jumpMiss: 0.3, lift: 0.22, mudAvoid: false }),
  pro: Object.freeze({ lookahead: 0.46, line: 0.18, wobble: 0.16, deadband: 0.06, jumpLead: 60, jumpJitter: 24, jumpMiss: 0.12, lift: 0.1, mudAvoid: false }),
  champion: Object.freeze({ lookahead: 0.56, line: 0.3, wobble: 0.06, deadband: 0.035, jumpLead: 58, jumpJitter: 10, jumpMiss: 0.025, lift: 0.015, mudAvoid: true }),
});

export function cpuKnobs(level) {
  return CPU_KNOBS[level] ?? CPU_KNOBS.pro;
}

const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

// Obstacle stations are a property of the track, worked out once per track object.
const stationCache = new WeakMap();
function obstacleStations(track) {
  let cached = stationCache.get(track);
  if (!cached) {
    cached = new Map(track.obstacles.map((obstacle) => [obstacle.id, roadStation(obstacle, track)]));
    stationCache.set(track, cached);
  }
  return cached;
}

function aheadOf(from, to, length) {
  return ((to - from) % length + length) % length;
}

/** Where across the road (−1 left … 1 right of the centre line) a point sits. */
function lateralOf(point, centre) {
  const acrossX = -Math.sin(centre.angle);
  const acrossY = Math.cos(centre.angle);
  return (point.x - centre.x) * acrossX + (point.y - centre.y) * acrossY;
}

/** How far along its heading a racer is from crossing an obstacle's line, or null if it is not heading at it. */
function rayToLine(racer, obstacle) {
  const dirX = Math.cos(racer.angle);
  const dirY = Math.sin(racer.angle);
  const lineX = Math.cos(obstacle.angle);
  const lineY = Math.sin(obstacle.angle);
  const denominator = dirX * lineY - dirY * lineX;
  if (Math.abs(denominator) < 0.2) return null;
  const dx = obstacle.x - racer.x;
  const dy = obstacle.y - racer.y;
  const along = (dx * lineY - dy * lineX) / denominator;
  const across = (dx * dirY - dy * dirX) / denominator;
  if (along < 0 || Math.abs(across) > obstacle.length / 2 + 20) return null;
  return along;
}

function idSide(id) {
  let value = 0;
  for (const character of String(id)) value += character.charCodeAt(0);
  return value % 2 ? -1 : 1;
}

function gateDetour(racer, obstacle, track, halfWidth) {
  const centre = pointAtStation(track, roadStation(obstacle, track));
  const gateLateral = lateralOf(obstacle, centre);
  // Go through the wider of the two gaps the gate leaves; ties by the racer's own side.
  const leftGap = gateLateral - obstacle.length / 2 + halfWidth;
  const rightGap = halfWidth - (gateLateral + obstacle.length / 2);
  const side = Math.abs(leftGap - rightGap) < 8 ? idSide(racer.id) : leftGap > rightGap ? -1 : 1;
  const target = side < 0 ? (gateLateral - obstacle.length / 2 - halfWidth) / 2 : (gateLateral + obstacle.length / 2 + halfWidth) / 2;
  return target / halfWidth;
}

/**
 * Controls for one CPU racer this tick.
 * `options.level` picks the hands, `tick` and `seed` feed its deterministic imperfection.
 */
export function cpuControls(racer, track, brokenObstacles = [], options = {}) {
  const knobs = cpuKnobs(options.level);
  const tick = Math.max(0, Math.floor(Number(options.tick) || 0));
  const seed = options.seed ?? 0;
  const halfWidth = track.roadWidth / 2;
  const maxSpeed = 165 * (racer.profile.speedMultiplier ?? 1);
  const speed = Math.max(0, racer.speed);

  // Off the road: head straight back to it before anything else.
  const nearest = closestPointOnRoad(racer, track);
  if (nearest.distance > track.roadWidth * 0.42) {
    const wanted = Math.atan2(nearest.y - racer.y, nearest.x - racer.x);
    const turn = wrapAngle(wanted - racer.angle);
    return { throttle: true, brake: false, left: turn < -0.04, right: turn > 0.04, jump: false };
  }

  const length = roadLength(track);
  const station = roadStation(racer, track);
  const here = pointAtStation(track, station);
  const look = Math.max(38, Math.max(speed, 60) * knobs.lookahead);
  const aim = pointAtStation(track, station + look);
  const further = pointAtStation(track, station + look * 2.2);
  const bend = wrapAngle(further.angle - here.angle);

  // The racing line: toward the inside of the coming bend, with this driver's drift on top.
  const halfSecond = Math.floor(tick / 30);
  const drift = (noise(seed, racer.id, "drift", Math.floor(tick / 45)) - 0.5) * 2 * knobs.wobble;
  let offset = Math.max(-1, Math.min(1, bend * 1.4)) * knobs.line + drift;

  // Obstacles within reach, by how far ahead along the road they stand.
  const stations = obstacleStations(track);
  let jump = false;
  let gap = null;
  const radius = racer.profile.radius;
  for (const obstacle of track.obstacles) {
    if (brokenObstacles.includes(obstacle.id)) continue;
    const ahead = aheadOf(station, stations.get(obstacle.id) ?? 0, length);
    if (ahead > 190) continue;
    const centre = pointAtStation(track, stations.get(obstacle.id) ?? 0);
    const obstacleLateral = lateralOf(obstacle, centre);
    const racerLateral = lateralOf(racer, here);

    if (obstacle.kind === "gate") {
      const canSmash = speed * racer.profile.gatePower >= 96;
      const inLane = Math.abs(racerLateral - obstacleLateral) < obstacle.length / 2 + radius + 6;
      if (!canSmash && ahead < 140 && (inLane || racer.lastImpact === "gate")) {
        offset = gateDetour(racer, obstacle, track, halfWidth);
        // Close in, steer for the gap itself rather than down the road past it.
        if (ahead < 90) gap = { station: stations.get(obstacle.id) ?? 0, offset };
      }
      continue;
    }

    const reach = obstacle.kind === "hurdle" ? Infinity : (obstacle.radius ?? 20) + radius + 4;
    if (Math.abs(racerLateral - obstacleLateral) > reach) continue;
    // A hurdle is a line across the road: time the jump by where this pet's own heading meets it,
    // which is nearer than the centre line says when the pet is cutting the inside of a bend.
    const distance = obstacle.kind === "hurdle" ? rayToLine(racer, obstacle) ?? ahead : ahead;
    // Each hurdle, each lap, gets one roll of the dice: when to go, and whether it goes at all.
    // A pet pinned against it (it ran in, or has barely any pace) always tries again.
    const roll = `${obstacle.id}:${racer.lap}`;
    const pinned = distance < radius + 60 && speed < 100;
    if (pinned) {
      jump = true;
      continue;
    }
    if (noise(seed, racer.id, "miss", roll) < knobs.jumpMiss) continue;
    const lead = knobs.jumpLead * Math.max(0.55, speed / 150) + (noise(seed, racer.id, "lead", roll) - 0.5) * 2 * knobs.jumpJitter;
    if (distance - radius <= lead && distance > 4) jump = true;
  }

  // Mud a careful driver can see coming: pick the nearest line that misses it.
  if (knobs.mudAvoid) {
    for (let probe = 60; probe <= 200; probe += 35) {
      const point = pointAtStation(track, station + probe);
      const across = { x: -Math.sin(point.angle), y: Math.cos(point.angle) };
      const at = (value) => ({ x: point.x + across.x * value * halfWidth, y: point.y + across.y * value * halfWidth });
      const zone = track.mud.find((rect) => pointInRect(at(offset), rect));
      if (!zone) continue;
      const clear = [-0.72, -0.5, -0.25, 0.25, 0.5, 0.72].filter((value) => !pointInRect(at(value), zone));
      if (clear.length) offset = clear.sort((left, right) => Math.abs(left - offset) - Math.abs(right - offset))[0];
      break;
    }
  }

  offset = Math.max(-0.62, Math.min(0.62, offset));
  const toward = gap ? pointAtStation(track, gap.station + 12) : aim;
  const lateral = gap ? gap.offset : offset;
  const across = { x: -Math.sin(toward.angle), y: Math.cos(toward.angle) };
  const target = { x: toward.x + across.x * lateral * halfWidth, y: toward.y + across.y * lateral * halfWidth };
  const wanted = Math.atan2(target.y - racer.y, target.x - racer.x);
  const turn = wrapAngle(wanted - racer.angle);

  const lifting = noise(seed, racer.id, "lift", halfSecond) < knobs.lift;
  const hardTurn = Math.abs(turn) > 1.15;
  return {
    throttle: !lifting && !(hardTurn && speed > maxSpeed * 0.55),
    brake: hardTurn && speed > maxSpeed * 0.6,
    left: turn < -knobs.deadband,
    right: turn > knobs.deadband,
    // A fresh press only from the ground: a held jump never takes off again.
    jump: jump && racer.jumpHeight <= 0 && !racer.jumpHeld,
  };
}
