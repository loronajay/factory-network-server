// The Pondside Push match: pure rules, fixed steps, mutable state.
//
// Pets are seats keyed by id. A seat is a person (its controls arrive in the
// map `stepMatch` is given) or a CPU (`cpu` names its level; session.js asks
// cpu.js for its controls). The same code runs a local match in the browser
// and an online one on the network server, which mirrors this folder byte for
// byte — so a splash is decided in exactly one place.

import { bumpPowerForSpeed, movementProfile } from "./balance.js?v=20260928-pet-online";

export const ARENA_RADIUS = 260;
export const WINS_TO_MATCH = 3;
export const MAX_PETS = 4;
/** A round that goes this long starts to shrink the island, so no stand-off lasts forever. */
export const SHRINK_AFTER_SECONDS = 15;
const SHRINK_PER_SECOND = 12;
// The island keeps going until it is gone: the last pet dry wins, and a pair that go in together replay the round.
const MIN_ISLAND_RADIUS = 0;
const BUMP_SECONDS = 0.2;
const BUMP_COOLDOWN = 0.85;
const BUMP_DASH_SPEED = 95;
const BUMP_RECOIL = 0.18;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const magnitude = (x, y) => Math.hypot(x, y);

/** `[{ id, pet, cpu? }]`, or bare pets (their `instanceId` is the id; the first is the local player). */
function entrantsOf(list) {
  return list.slice(0, MAX_PETS).map((item, index) => (item && typeof item === "object" && item.pet
    ? { id: String(item.id), pet: item.pet, cpu: item.cpu ?? null, player: false }
    : { id: String(item.instanceId), pet: item, cpu: null, player: index === 0 }));
}

function spawnPlayer(entrant, index, count) {
  const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
  const profile = movementProfile(entrant.pet.stats, entrant.pet.speciesId);
  return {
    id: entrant.id,
    player: entrant.player,
    cpu: entrant.cpu,
    left: false,
    pet: entrant.pet,
    x: Math.cos(angle) * 92,
    y: Math.sin(angle) * 92,
    vx: 0,
    vy: 0,
    facingX: -Math.cos(angle),
    facingY: -Math.sin(angle),
    momentum: 0,
    radius: profile.radius,
    wins: 0,
    eliminated: false,
    bumpTimer: 0,
    bumpCooldown: 0,
    bumpSourceSpeed: 0,
    bumpHits: [],
    impact: 0,
    fallHeight: 0,
    fallSpeed: 0,
    splashAge: -1,
  };
}

export function createMatch(list, { winsToMatch = WINS_TO_MATCH } = {}) {
  if (!Array.isArray(list) || list.length < 2) throw new Error("Pondside Push needs at least two pets");
  const entrants = entrantsOf(list);
  return {
    players: entrants.map((entrant, index) => spawnPlayer(entrant, index, entrants.length)),
    phase: "playing",
    round: 1,
    tick: 0,
    roundTicks: 0,
    islandRadius: ARENA_RADIUS,
    winsToMatch: Math.max(1, Math.min(5, Math.floor(Number(winsToMatch) || WINS_TO_MATCH))),
    roundWinnerId: null,
    matchWinnerId: null,
  };
}

export function resetRound(match) {
  const count = match.players.length;
  match.players.forEach((player, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
    Object.assign(player, {
      x: Math.cos(angle) * 92,
      y: Math.sin(angle) * 92,
      vx: 0,
      vy: 0,
      facingX: -Math.cos(angle),
      facingY: -Math.sin(angle),
      momentum: 0,
      // A seat that left stays out: it sits in the water for the rest of the match.
      eliminated: player.left,
      bumpTimer: 0,
      bumpCooldown: 0,
      bumpSourceSpeed: 0,
      bumpHits: [],
      impact: 0,
      fallHeight: player.left ? 40 : 0,
      fallSpeed: 0,
      splashAge: player.left ? 5 : -1,
    });
  });
  match.phase = "playing";
  match.round += 1;
  match.roundTicks = 0;
  match.islandRadius = ARENA_RADIUS;
  match.roundWinnerId = null;
}

/** The part of a step that only one pet's own input decides (an online client predicts its pet with it). */
export function movePlayer(player, input, dt) {
  player.impact = Math.max(0, player.impact - dt * 4.5);
  if (player.eliminated) {
    player.fallSpeed += 520 * dt;
    player.fallHeight += player.fallSpeed * dt;
    player.x += player.vx * dt;
    player.y += player.vy * dt;
    player.vx *= Math.pow(0.985, dt * 60);
    player.vy *= Math.pow(0.985, dt * 60);
    if (player.fallHeight >= 19 && player.splashAge < 0) player.splashAge = 0;
    else if (player.splashAge >= 0) player.splashAge += dt;
    return;
  }
  const profile = movementProfile(player.pet.stats, player.pet.speciesId);
  const inputLength = magnitude(input?.x || 0, input?.y || 0);
  const previousSpeed = magnitude(player.vx, player.vy);

  if (inputLength > 0.1) {
    const dx = input.x / inputLength;
    const dy = input.y / inputLength;
    const travelX = previousSpeed > 4 ? player.vx / previousSpeed : player.facingX;
    const travelY = previousSpeed > 4 ? player.vy / previousSpeed : player.facingY;
    const alignment = dx * travelX + dy * travelY;
    player.momentum = alignment > 0.72
      ? clamp(player.momentum + dt / profile.momentumBuildSeconds, 0, 1)
      : clamp(player.momentum - dt * 2.8, 0, 1);
    player.facingX = dx;
    player.facingY = dy;
    const targetSpeed = profile.maxSpeed * (0.42 + player.momentum * 0.58);
    player.vx += dx * profile.acceleration * dt;
    player.vy += dy * profile.acceleration * dt;
    const speed = magnitude(player.vx, player.vy);
    if (speed > targetSpeed) {
      player.vx *= targetSpeed / speed;
      player.vy *= targetSpeed / speed;
    }
  } else {
    player.momentum = clamp(player.momentum - dt * 1.4, 0, 1);
  }

  if (input?.bump && player.bumpCooldown <= 0) {
    player.bumpSourceSpeed = previousSpeed;
    player.bumpHits = [];
    player.bumpTimer = BUMP_SECONDS;
    player.bumpCooldown = BUMP_COOLDOWN;
    player.vx += player.facingX * BUMP_DASH_SPEED;
    player.vy += player.facingY * BUMP_DASH_SPEED;
  }

  player.bumpTimer = Math.max(0, player.bumpTimer - dt);
  player.bumpCooldown = Math.max(0, player.bumpCooldown - dt);
  const drag = Math.pow(inputLength > 0.1 ? 0.994 : 0.965, dt * 60);
  player.vx *= drag;
  player.vy *= drag;
  player.x += player.vx * dt;
  player.y += player.vy * dt;
}

function applyBump(attacker, target, nx, ny) {
  if (attacker.bumpHits.includes(target.id)) return;
  attacker.bumpHits.push(target.id);
  const force = bumpPowerForSpeed(attacker.bumpSourceSpeed, attacker.pet.stats);
  target.vx += nx * force;
  target.vy += ny * force;
  attacker.vx -= nx * force * BUMP_RECOIL;
  attacker.vy -= ny * force * BUMP_RECOIL;
  target.impact = 1;
  attacker.impact = Math.max(attacker.impact, 0.58);
}

function resolvePair(a, b) {
  if (a.eliminated || b.eliminated) return;
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let distance = magnitude(dx, dy);
  const bumpReach = a.bumpTimer > 0 || b.bumpTimer > 0 ? 8 : 0;
  const minimum = a.radius + b.radius + bumpReach;
  if (distance > minimum) return;
  if (distance < 0.001) { dx = 1; dy = 0; distance = 1; }
  const nx = dx / distance;
  const ny = dy / distance;
  const overlap = minimum - distance;
  a.x -= nx * overlap / 2;
  a.y -= ny * overlap / 2;
  b.x += nx * overlap / 2;
  b.y += ny * overlap / 2;

  const relative = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (relative > 0) {
    const impulse = relative * 0.58;
    a.vx -= nx * impulse;
    a.vy -= ny * impulse;
    b.vx += nx * impulse;
    b.vy += ny * impulse;
  }
  if (a.bumpTimer > 0 && a.facingX * nx + a.facingY * ny > 0.35) {
    applyBump(a, b, nx, ny);
  }
  if (b.bumpTimer > 0 && -(b.facingX * nx + b.facingY * ny) > 0.35) {
    applyBump(b, a, -nx, -ny);
  }
}

function eliminate(player) {
  player.eliminated = true;
  player.fallHeight = 0;
  player.fallSpeed = 0;
  player.splashAge = -1;
}

function settleRound(match) {
  for (const player of match.players) {
    if (!player.eliminated && magnitude(player.x, player.y) > match.islandRadius + player.radius * 0.25) eliminate(player);
  }
  const survivors = match.players.filter((player) => !player.eliminated);
  if (survivors.length > 1) return;
  // Two pets can go in together; then nobody takes the round and it is played again.
  const winner = survivors[0] ?? null;
  match.roundWinnerId = winner?.id ?? null;
  if (!winner) {
    match.phase = "round-over";
    return;
  }
  winner.wins += 1;
  // A match with only one seat still in it is that seat's, however the score stands.
  const standing = match.players.filter((player) => !player.left);
  if (winner.wins >= match.winsToMatch || standing.length <= 1) {
    match.phase = "match-over";
    match.matchWinnerId = winner.id;
  } else {
    match.phase = "round-over";
  }
}

export function stepMatch(match, controls = {}, dt = 1 / 60) {
  if (match.phase !== "playing") {
    match.players.forEach((player) => movePlayer(player, {}, dt));
    return match;
  }
  match.tick += 1;
  match.roundTicks = (match.roundTicks ?? 0) + 1;
  const roundSeconds = match.roundTicks * dt;
  if (roundSeconds > SHRINK_AFTER_SECONDS) {
    match.islandRadius = Math.max(MIN_ISLAND_RADIUS, match.islandRadius - SHRINK_PER_SECOND * dt);
  }
  match.players.forEach((player) => movePlayer(player, controls[player.id] || {}, dt));
  for (let a = 0; a < match.players.length; a += 1) {
    for (let b = a + 1; b < match.players.length; b += 1) resolvePair(match.players[a], match.players[b]);
  }
  settleRound(match);
  return match;
}

/** A seat that left the match: it goes in the water now and stays out. */
export function retirePlayer(match, id) {
  const player = match.players.find((entry) => entry.id === id);
  if (!player || player.left) return false;
  player.left = true;
  if (!player.eliminated) eliminate(player);
  if (match.phase === "playing") settleRound(match);
  return true;
}

/** The only thing a person may send: a direction and a bump. */
export function readPushInput(value) {
  const source = value && typeof value === "object" ? value : {};
  const axis = (number) => (Number.isFinite(Number(number)) ? clamp(Number(number), -1, 1) : 0);
  return { x: axis(source.x), y: axis(source.y), bump: source.bump === true };
}
