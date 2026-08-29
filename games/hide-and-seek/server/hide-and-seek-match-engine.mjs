// Hide and Seek: the authoritative match.
//
// This server owns the round. Clients send **inputs** — a direction, a facing and three held keys —
// and receive snapshots; they never report a position, a battery level or a tag. Every rule that
// turns those inputs into a round lives in `../shared/`, which is a byte-for-byte mirror of the
// cabinet's pure layer, so "who was caught" is answered by the same code in both places.
//
// Not here yet: the demons. Online rounds open with the hotel empty of them, because the demon's
// navigation still lives in the cabinet's rendering module. `endRoundByDemon` is already wired to
// the one place a round is allowed to end, so nothing downstream changes when the hunt arrives.
import {
  CONFIG, FLOOR_DEFS, FLASHLIGHT_CONFIG, ROUND_CONFIG, SANITY_CONFIG, STAMINA_CONFIG,
  floorY, keyIdForFloor, keyLabelForFloor,
  collision, layout, movement, plan, round, sanity, sim, stamina, flashlight,
} from "../shared/index.mjs";

export const HIDE_AND_SEEK_GAME_ID = "hide-and-seek";
export const HIDE_AND_SEEK_PROTOCOL_VERSION = 1;
export const HIDE_AND_SEEK_RECONNECT_GRACE_MS = 30_000;
// Gameplay is a fixed 60hz tick — the cabinet's rate, and the only rate the mirrored rules are
// tuned for. Snapshots go out far less often; a body moves smoothly between them on the client.
export const HIDE_AND_SEEK_TICK_RATE = 60;
export const HIDE_AND_SEEK_SNAPSHOT_HZ = 15;
// A stalled process must not replay minutes of hotel in one frame.
const MAX_TICKS_PER_ADVANCE = 12;
const STEP_SECONDS = 1 / HIDE_AND_SEEK_TICK_RATE;

export const HIDE_AND_SEEK_LOBBY_LIMITS = Object.freeze({ minPlayers: 2, maxPlayers: 8 });

// The hotel is identical in every match and the plan is immutable, so it is built once. Door state
// is not in here — that lives per match, in the space.
let cachedHotel = null;
export function hotelPlan() {
  if (!cachedHotel) {
    cachedHotel = plan.createHotelPlan({
      config: CONFIG, floorDefs: FLOOR_DEFS, layout, floorY, keyIdForFloor, keyLabelForFloor,
    });
  }
  return cachedHotel;
}

function sanityZones(hotel) {
  return [
    ...hotel.roomCenters.map((room) => ({
      id: room.roomNumber, kind: sanity.ZONE_KINDS.ROOM, floor: room.floor, x: room.x, z: room.z,
    })),
    ...hotel.secretTunnels,
  ];
}

function clean(value, max, fallback = "") {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, max);
}

// A seed is a room code's worth of characters, not a number, so it is folded into one.
export function seedNumber(seed) {
  const text = String(seed || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Who is it. Deterministic from the match seed so the pick can be replayed, and never a client's
// choice — being the seeker is the whole shape of a round.
export function chooseSeeker(memberIds, seed) {
  if (!memberIds.length) return null;
  return memberIds[seedNumber(seed) % memberIds.length];
}

function seatPlayers(hotel, memberIds, seekerId, seed) {
  const spawns = hotel.spawns.hiders;
  let cursor = seedNumber(seed) % Math.max(1, spawns.length);
  return memberIds.map((id) => {
    if (id === seekerId) {
      const seat = hotel.spawns.seeker;
      return { id, spawn: { x: seat.x, y: seat.y, z: seat.z, floor: seat.floor } };
    }
    const seat = spawns[cursor % spawns.length];
    cursor += 1;
    return { id, spawn: { x: seat.x, y: seat.y, z: seat.z, floor: seat.floor } };
  });
}

function profileFor(lobby, clientId, index) {
  const profile = lobby?.memberProfiles?.get(clientId) || {};
  return {
    accountPlayerId: clean(profile.playerId, 64),
    name: clean(profile.displayName, 24, `Guest ${index + 1}`),
  };
}

export function createHideAndSeekMatchState(lobby, startAt) {
  const hotel = hotelPlan();
  const memberIds = [...(lobby?.members || [])];
  const seed = clean(lobby?.seed, 32, "seed");
  const seekerId = chooseSeeker(memberIds, seed);
  const space = sim.createPlanSpace({ plan, collision, hotel, config: CONFIG });
  const engine = sim.createSimulation({
    movement, round, stamina, flashlight, sanity, space,
    zones: sanityZones(hotel),
    config: {
      player: CONFIG,
      round: ROUND_CONFIG,
      stamina: STAMINA_CONFIG,
      sanity: SANITY_CONFIG,
      flashlight: FLASHLIGHT_CONFIG,
    },
  });
  const seats = seatPlayers(hotel, memberIds, seekerId, seed);
  return {
    gameId: HIDE_AND_SEEK_GAME_ID,
    protocolVersion: HIDE_AND_SEEK_PROTOCOL_VERSION,
    roomCode: clean(lobby?.roomCode, 8),
    authorityMode: "server",
    phase: "scheduled",
    seed,
    seekerId,
    startAt: Number(startAt) || Date.now(),
    tickRate: HIDE_AND_SEEK_TICK_RATE,
    engine,
    space,
    state: engine.createState({ players: seats, seekerId }),
    // The latest input from each client. A tick reads it; it is never a queue, because a client that
    // stops sending should keep walking into the wall it was already walking into, not bank moves.
    inputs: new Map(),
    profiles: new Map(memberIds.map((id, index) => [id, profileFor(lobby, id, index)])),
    connected: new Set(memberIds),
    lastAdvanceAt: Number(startAt) || Date.now(),
    snapshotTick: -1,
  };
}

// The only thing a client is allowed to say. `sim-logic.readInput` does the narrowing; anything else
// on the message — a position, a charge, a claim about a tag — never reaches the state.
export function applyHideAndSeekInput(match, clientId, value) {
  if (!match || !match.state.bodies.some((body) => body.id === clientId)) return false;
  match.inputs.set(clientId, sim.readInput(value));
  return true;
}

function currentInputs(match) {
  const inputs = {};
  for (const [id, input] of match.inputs) {
    // A body nobody is driving stands still rather than repeating its last stride into a corridor.
    inputs[id] = match.connected.has(id) ? input : sim.NO_INPUT;
  }
  return inputs;
}

export function advanceHideAndSeekMatch(match, now = Date.now()) {
  if (!match || match.phase === "complete") return match;
  if (now < match.startAt) return match;
  if (match.phase === "scheduled") {
    match.phase = "active";
    match.lastAdvanceAt = match.startAt;
  }
  const owed = Math.floor((now - match.lastAdvanceAt) / 1000 / STEP_SECONDS);
  const ticks = Math.min(Math.max(0, owed), MAX_TICKS_PER_ADVANCE);
  if (owed > ticks) match.lastAdvanceAt = now;
  else match.lastAdvanceAt += ticks * STEP_SECONDS * 1000;
  const inputs = currentInputs(match);
  for (let tick = 0; tick < ticks; tick += 1) match.state = match.engine.tick(match.state, STEP_SECONDS, inputs);
  if (match.engine.snapshot(match.state).round.over) match.phase = "complete";
  return match;
}

// A demon kill and a lost seeker are the same call, because the round has exactly one place it is
// allowed to end. This is the hook the hunt will use once it runs server-side.
export function endRoundByDemon(match, playerId) {
  if (!match || match.phase === "complete") return match;
  match.state = match.engine.resolveDemonCatch(match.state, playerId);
  if (match.engine.snapshot(match.state).round.over) match.phase = "complete";
  return match;
}

export function applyHideAndSeekDisconnect(match, clientId, now = Date.now()) {
  if (!match || !match.connected.has(clientId)) return false;
  match.connected.delete(clientId);
  match.inputs.set(clientId, sim.NO_INPUT);
  // A dropped hider is left standing where they were — a free find, which is the honest consequence
  // and keeps the round winnable. A dropped seeker is not survivable for the round: nobody is left
  // hunting, so it settles the way a demon taking the seeker does.
  if (clientId === match.seekerId) endRoundByDemon(match, clientId);
  return true;
}

export function applyHideAndSeekReconnect(match, clientId) {
  if (!match || match.connected.has(clientId)) return false;
  if (!match.state.bodies.some((body) => body.id === clientId)) return false;
  match.connected.add(clientId);
  return true;
}

export function serializeHideAndSeekMatch(match, serverNow = Date.now()) {
  if (!match) return null;
  const snapshot = match.engine.snapshot(match.state);
  return {
    gameId: match.gameId,
    protocolVersion: match.protocolVersion,
    roomCode: match.roomCode,
    authorityMode: match.authorityMode,
    phase: match.phase,
    seed: match.seed,
    seekerId: match.seekerId,
    startAt: match.startAt,
    tickRate: match.tickRate,
    serverNow,
    tick: snapshot.tick,
    round: snapshot.round,
    players: snapshot.players.map((player) => ({
      ...player,
      name: match.profiles.get(player.id)?.name || "Guest",
      accountPlayerId: match.profiles.get(player.id)?.accountPlayerId || "",
      connected: match.connected.has(player.id),
    })),
  };
}
