// The race: one pure function of the race so far and everybody's controls.
//
// A race is a list of racers keyed by id. Some are people (their controls
// arrive in the map `stepRace` is given), some are CPUs (`cpu` names their
// level, and `cpu.js` makes their controls here, inside the step). The same
// step runs in a browser for a local race and on the network server for an
// online one — this folder is mirrored there byte for byte — so there is only
// ever one answer to who crossed the line first.

import { racePetProfile } from "./balance.js?v=20260928-pet-online";
import { cpuControls } from "./cpu.js?v=20260928-pet-online";
import { confineToCourse, crossesGate, distanceFromRoad, pointInRect, roadStation, segmentCapsuleIntersection, segmentCircleIntersection } from "./track.js?v=20260928-pet-online";

const BASE_TOP_SPEED = 165;
const ACCELERATION = 100;
const BRAKING = 185;
const COAST_DRAG = 28;
const STEER_RATE = 2.45;
const GRAVITY = 13;
/** The least pace a jump leaves the ground with. */
export const HOP_SPEED = 70;
/** How far a pet that runs into a hurdle or bale rebounds from it. */
const BOUNCE_BACK = 20;

export const MAX_RACERS = 8;
/** After the first pet finishes, the rest have this long to cross the line. */
export const FINISH_WINDOW_SECONDS = 30;
/** No race outlives this, however it is going. */
export const TIME_LIMIT_SECONDS = 600;

function spawn(entrant, start, laneOffset) {
  return {
    id: String(entrant.id),
    human: entrant.cpu == null,
    cpu: entrant.cpu ?? null,
    x: start.x - Math.sin(start.angle) * laneOffset,
    y: start.y + Math.cos(start.angle) * laneOffset,
    angle: start.angle,
    speed: 0,
    jumpHeight: 0,
    jumpVelocity: 0,
    jumpHeld: false,
    checkpoint: 0,
    lap: 1,
    finishedAt: null,
    dnf: false,
    lastImpact: null,
    pet: entrant.pet,
    // A farm-shaped pet carries its numbers under `stats`; a bare stat block is its own.
    profile: racePetProfile(entrant.pet?.stats ?? entrant.pet),
  };
}

/**
 * Line the field up on the grid.
 *
 * `entrants` is `[{ id, pet, cpu? }]` — `cpu` is a level id for a CPU racer,
 * absent for a person. The older `{ playerPet, cpuPets }` form still builds
 * a local race: the player is `"player"` and the rivals `"cpu-1"…`.
 */
export function createRace({
  track,
  entrants = null,
  playerPet = null,
  cpuPets = [],
  cpuLevel = "pro",
  countdownSeconds = 3,
  totalLaps = 3,
  seed = 1,
  finishWindowSeconds = FINISH_WINDOW_SECONDS,
  timeLimitSeconds = TIME_LIMIT_SECONDS,
}) {
  const field = (Array.isArray(entrants) ? entrants : [
    { id: "player", pet: playerPet },
    ...(Array.isArray(cpuPets) ? cpuPets : []).map((pet, index) => ({ id: `cpu-${index + 1}`, pet, cpu: cpuLevel })),
  ]).slice(0, MAX_RACERS);
  const count = field.length;
  const laneAt = (index) => (index - (count - 1) / 2) * Math.min(18, 105 / Math.max(1, count - 1));
  return {
    track,
    seed,
    tick: 0,
    elapsed: 0,
    countdown: Math.max(0, countdownSeconds),
    status: countdownSeconds > 0 ? "countdown" : "racing",
    totalLaps: Math.max(1, Math.min(9, Math.round(Number(totalLaps) || 3))),
    finishWindow: Math.max(1, Number(finishWindowSeconds) || FINISH_WINDOW_SECONDS),
    timeLimit: Math.max(10, Number(timeLimitSeconds) || TIME_LIMIT_SECONDS),
    firstFinishAt: null,
    racers: field.map((entrant, index) => spawn(entrant, track.start, laneAt(index))),
    brokenObstacles: [],
  };
}

export function racerById(race, id) {
  return race.racers.find((racer) => racer.id === id) ?? null;
}

/** A copy of the race with one racer patched (tests and presentation only). */
export function withRacer(race, id, patch) {
  return { ...race, racers: race.racers.map((racer) => (racer.id === id ? { ...racer, ...patch } : racer)) };
}

function controlsOf(value = {}) {
  return {
    throttle: value.throttle === true,
    brake: value.brake === true,
    left: value.left === true,
    right: value.right === true,
    jump: value.jump === true,
  };
}

/** The only thing a person may send: five booleans. */
export function readRaceInput(value) {
  return controlsOf(value && typeof value === "object" ? value : {});
}

function obstacleHit(start, end, obstacle, racerRadius) {
  if (Number.isFinite(obstacle.length) && Number.isFinite(obstacle.angle)) {
    const halfLength = obstacle.length / 2;
    const dx = Math.cos(obstacle.angle) * halfLength;
    const dy = Math.sin(obstacle.angle) * halfLength;
    return segmentCapsuleIntersection(
      start,
      end,
      { x: obstacle.x - dx, y: obstacle.y - dy },
      { x: obstacle.x + dx, y: obstacle.y + dy },
      racerRadius + Math.max(0, Number(obstacle.thickness) || 0) / 2,
    );
  }
  const radius = racerRadius + Math.max(0, Number(obstacle.radius) || 0);
  const hit = segmentCircleIntersection(start, end, obstacle, radius);
  return hit ? { ...hit, closestX: obstacle.x, closestY: obstacle.y } : null;
}

/** A gate checkpoint spans the course; a bare {x, y, radius} one is a circle (small test tracks). */
function checkpointReached(start, end, checkpoint) {
  return checkpoint.gate
    ? crossesGate(start, end, checkpoint)
    : Boolean(segmentCircleIntersection(start, end, checkpoint, checkpoint.radius));
}

const out = (racer) => racer.finishedAt !== null || racer.dnf;

function separateRacers(entries) {
  const racers = entries.map((entry) => ({ ...entry }));
  for (let leftIndex = 0; leftIndex < racers.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < racers.length; rightIndex += 1) {
      const left = racers[leftIndex];
      const right = racers[rightIndex];
      if (out(left) || out(right) || Math.abs(left.jumpHeight - right.jumpHeight) > 0.55) continue;
      const dx = right.x - left.x;
      const dy = right.y - left.y;
      const distance = Math.hypot(dx, dy);
      const minimum = (left.profile.radius + right.profile.radius) * 0.72;
      if (distance >= minimum) continue;
      const normalX = distance ? dx / distance : left.id.localeCompare(right.id) <= 0 ? 1 : -1;
      const normalY = distance ? dy / distance : 0;
      const correction = (minimum - distance) / 2 + 0.01;
      left.x -= normalX * correction;
      left.y -= normalY * correction;
      right.x += normalX * correction;
      right.y += normalY * correction;
      left.speed *= 0.97;
      right.speed *= 0.97;
    }
  }
  return racers;
}

/**
 * One racer, one step, alone on the course (no other bodies).
 * The race uses it for everybody; an online client uses it to predict its own pet.
 */
export function advanceRacer(source, rawControls, dt, track, brokenObstacles, totalLaps) {
  if (out(source)) return { racer: source, brokenObstacles };
  const input = controlsOf(rawControls);
  const racer = { ...source, lastImpact: null };
  const previous = { x: racer.x, y: racer.y };
  const maxSpeed = BASE_TOP_SPEED * racer.profile.speedMultiplier;

  if (input.throttle) racer.speed = Math.min(maxSpeed, racer.speed + ACCELERATION * dt);
  else racer.speed = Math.max(0, racer.speed - COAST_DRAG * dt);
  if (input.brake) racer.speed = Math.max(0, racer.speed - BRAKING * dt);

  const steering = (Number(input.right) - Number(input.left)) * STEER_RATE * (0.22 + 0.78 * Math.min(1, racer.speed / maxSpeed));
  racer.angle += steering * dt;

  if (input.jump && !racer.jumpHeld && racer.jumpHeight <= 0) {
    racer.jumpVelocity = 5.7;
    // A jump from a near-standstill is a hop: enough pace to carry the pet over a
    // rail it just bounced off, so no pet can be left stuck facing a hurdle.
    racer.speed = Math.max(racer.speed, HOP_SPEED);
  }
  racer.jumpHeld = input.jump;
  racer.jumpVelocity -= GRAVITY * dt;
  racer.jumpHeight = Math.max(0, racer.jumpHeight + racer.jumpVelocity * dt);
  if (racer.jumpHeight === 0 && racer.jumpVelocity < 0) racer.jumpVelocity = 0;

  racer.x += Math.cos(racer.angle) * racer.speed * dt;
  racer.y += Math.sin(racer.angle) * racer.speed * dt;

  if (distanceFromRoad(racer, track) > track.roadWidth / 2) racer.speed *= Math.max(0, 1 - 2.8 * dt);
  if (track.mud.some((zone) => pointInRect(racer, zone))) {
    racer.speed *= Math.max(0, 1 - (1 - racer.profile.mudGrip) * 3.8 * dt);
  }

  // How far along its path the pet really got this step: a bounce off a rail
  // moves it back, but it did reach the rail, and any gate line before it.
  let reached = { x: racer.x, y: racer.y };
  let broken = brokenObstacles;
  for (const obstacle of track.obstacles) {
    if (broken.includes(obstacle.id)) continue;
    const hit = obstacleHit(previous, racer, obstacle, racer.profile.radius);
    if (!hit) continue;
    if (racer.jumpHeight > 0.45 && (obstacle.kind === "hurdle" || obstacle.kind === "hay")) continue;

    const gateForce = racer.speed * racer.profile.gatePower;
    const canBreak = obstacle.kind === "hay" ? gateForce >= 65 : obstacle.kind === "gate" && gateForce >= 90;
    if (canBreak) {
      broken = [...broken, obstacle.id];
      racer.speed *= 0.92;
      racer.lastImpact = obstacle.kind;
      continue;
    }

    racer.speed *= racer.profile.impactRetention;
    racer.lastImpact = obstacle.kind;
    reached = { x: hit.x, y: hit.y };
    const distance = Math.hypot(hit.x - hit.closestX, hit.y - hit.closestY);
    const nx = distance ? (hit.x - hit.closestX) / distance : -Math.cos(racer.angle);
    const ny = distance ? (hit.y - hit.closestY) / distance : -Math.sin(racer.angle);
    // A low obstacle bounces the pet back a run-up's length; a gate or fence just stops it.
    const bounce = obstacle.kind === "hurdle" || obstacle.kind === "hay" ? BOUNCE_BACK : 0.1;
    const clearance = racer.profile.radius + Math.max(0, Number(obstacle.thickness) || Number(obstacle.radius) * 2 || 0) / 2 + bounce;
    racer.x = hit.closestX + nx * clearance;
    racer.y = hit.closestY + ny * clearance;
  }

  // The course fence is a wall: nothing, jumping included, leaves the track.
  // Head-on contact costs most of the speed, a glancing scrape very little.
  const wall = confineToCourse(racer, track, racer.profile.radius);
  if (wall) {
    racer.x = wall.x;
    racer.y = wall.y;
    const into = Math.max(0, Math.cos(racer.angle) * wall.normalX + Math.sin(racer.angle) * wall.normalY);
    racer.speed *= 1 - 0.6 * into;
    racer.lastImpact = racer.lastImpact ?? "fence";
  }

  const checkpoint = track.checkpoints[racer.checkpoint];
  if (checkpoint && checkpointReached(previous, wall ? racer : reached, checkpoint)) {
    if (racer.checkpoint === track.checkpoints.length - 1 && racer.lap < totalLaps) {
      racer.lap += 1;
      racer.checkpoint = 0;
    } else {
      racer.checkpoint += 1;
    }
  }
  return { racer, brokenObstacles: broken };
}

/** True when the value is one racer's controls rather than a map of them (the local shorthand). */
function isSingleControls(value) {
  return value && typeof value === "object" && ["throttle", "brake", "left", "right", "jump"].some((key) => typeof value[key] === "boolean");
}

/**
 * Advance the race one fixed step. `controls` maps racer id to that racer's
 * five buttons; a bare controls object drives the local `"player"`.
 */
export function stepRace(source, controls = {}, dt = 1 / 60) {
  const seconds = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.05)) : 0;
  if (seconds === 0 || source.status === "finished") return source;
  const countdown = Math.max(0, source.countdown - seconds);
  if (source.countdown > 0) return { ...source, countdown, status: countdown > 0 ? "countdown" : "racing" };

  const byId = isSingleControls(controls) ? { player: controls } : (controls ?? {});
  const elapsed = source.elapsed + seconds;
  let brokenObstacles = source.brokenObstacles;
  const stepped = source.racers.map((racer) => {
    const input = racer.cpu
      ? cpuControls(racer, source.track, brokenObstacles, { level: racer.cpu, tick: source.tick, seed: source.seed })
      : byId[racer.id];
    const next = advanceRacer(racer, input, seconds, source.track, brokenObstacles, source.totalLaps);
    brokenObstacles = next.brokenObstacles;
    return next.racer;
  });

  let firstFinishAt = source.firstFinishAt;
  let racers = separateRacers(stepped).map((entry) => {
    if (out(entry) || entry.checkpoint < source.track.checkpoints.length) return entry;
    if (firstFinishAt === null) firstFinishAt = elapsed;
    return { ...entry, finishedAt: elapsed };
  });

  // The field does not wait forever: a window after the winner, and a hard cap on the whole race.
  const windowShut = firstFinishAt !== null && elapsed - firstFinishAt >= source.finishWindow;
  if (windowShut || elapsed >= source.timeLimit) racers = racers.map((entry) => (out(entry) ? entry : { ...entry, dnf: true }));
  const status = racers.every(out) ? "finished" : "racing";

  return { ...source, tick: source.tick + 1, elapsed, countdown, status, firstFinishAt, racers, brokenObstacles };
}

/** Take a racer out of the race (an online seat that left): it keeps its place in the order by progress. */
export function retireRacer(race, id) {
  if (!racerById(race, id) || race.status === "finished") return race;
  const racers = race.racers.map((racer) => (racer.id === id && !out(racer) ? { ...racer, dnf: true } : racer));
  return { ...race, racers, status: racers.every(out) ? "finished" : race.status };
}

/** How far round the whole race a racer has got, in road units (orders unfinished racers). */
export function raceProgress(race, racer) {
  const track = race.track;
  const perLap = track.checkpoints.length;
  const passed = (racer.lap - 1) * perLap + racer.checkpoint;
  const target = track.checkpoints[Math.min(racer.checkpoint, perLap - 1)];
  const toGo = target ? Math.hypot(racer.x - target.x, racer.y - target.y) : 0;
  return passed * 100000 - toGo;
}

export function raceOrder(race) {
  return [...race.racers].sort((left, right) => {
    const leftDone = left.finishedAt !== null;
    const rightDone = right.finishedAt !== null;
    if (leftDone || rightDone) {
      if (!leftDone) return 1;
      if (!rightDone) return -1;
      return left.finishedAt - right.finishedAt || left.id.localeCompare(right.id);
    }
    return raceProgress(race, right) - raceProgress(race, left) || left.id.localeCompare(right.id);
  });
}

/** Where along the lap a racer is, for a minimap (0..1). */
export function lapFraction(race, racer) {
  const length = race.track.road.reduce((sum, point, index, road) => (index ? sum + Math.hypot(point.x - road[index - 1].x, point.y - road[index - 1].y) : 0), 0) || 1;
  return roadStation(racer, race.track) / length;
}
