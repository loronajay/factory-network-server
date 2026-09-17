// Hide and Seek: the authoritative match.
//
// This server owns the round. Clients send **inputs** — a direction, a facing and three held keys —
// and receive snapshots; they never report a position, a battery level or a tag. Every rule that
// turns those inputs into a round lives in `../shared/`, which is a byte-for-byte mirror of the
// cabinet's pure layer, so "who was caught" is answered by the same code in both places.
//
// The demons hunt here too. Their navigation, their line of sight and the catch they resolve all
// live in the mirrored `demon-logic.js`, and the doors they walk through in `fixtures-logic.js`, so
// the hotel a client draws and the hotel this server adjudicates are the same building.
//
// So do the CPU guests. A lobby's host can ask for bots to fill the empty chairs, and each one is an
// ordinary body in the tick with `cpu-logic.js` at its keyboard: it sends the same inputs a human
// sends and nothing else, so the authority cannot favour it even by accident. The seeker is always a
// real person — a bot only ever hides.
import {
  CONFIG, FLOOR_DEFS, FLASHLIGHT_CONFIG, ROUND_CONFIG, HEAT_CONFIG, STAMINA_CONFIG,
  floorY, keyIdForFloor, keyLabelForFloor,
  collision, cpu, demon, enemy, fixtures, hiders, layout, maps, movement, plan, round, heat, sim, stamina, flashlight,
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
// The most bots a host may ask for. The engine clamps it again to the chairs actually left empty.
export const HIDE_AND_SEEK_MAX_CPU = 6;

// A map's building is identical in every match and its plan is immutable, so each one is built once
// and shared. Door state is not in here — that lives per match, in the space.
//
// Which building a match happens in comes from the lobby's settings, because a client builds its map
// at boot and cannot be handed a different one: matchmaking keeps the two pools apart and the
// snapshot names the map so a client can refuse a round it has no geometry for.
const cachedPlans = new Map();
export function hotelPlan(mapId = maps.DEFAULT_MAP_ID) {
  const resolved = maps.playableMapId(mapId);
  if (!cachedPlans.has(resolved)) {
    cachedPlans.set(resolved, maps.resolveMapPlan(resolved, {
      config: CONFIG, floorDefs: FLOOR_DEFS, layout, floorY, keyIdForFloor, keyLabelForFloor,
    }));
  }
  return cachedPlans.get(resolved);
}

// The map a lobby is playing. Untrusted — it arrives as a lobby setting a client sent — so it is
// normalized to a map that actually has geometry before anything is built from it.
export function hideAndSeekMapId(lobby) {
  return maps.playableMapId(lobby?.settings?.mapId);
}

function heatZones(hotel) {
  return [
    ...hotel.roomCenters.map((room) => ({
      id: room.roomNumber, kind: heat.ZONE_KINDS.ROOM, floor: room.floor, x: room.x, z: room.z,
    })),
    ...hotel.secretTunnels,
  ];
}

function clean(value, max, fallback = "") {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, max);
}

// Every random choice a round makes — who is it, which spawn, where a demon patrols — comes out of
// the match seed, so a round can be replayed from its inputs. `Math.random` would make the
// authority's own history unreproducible.
export function seededRandom(seed) {
  let value = seedNumber(seed) || 1;
  return () => {
    value ^= value << 13; value >>>= 0;
    value ^= value >> 17;
    value ^= value << 5; value >>>= 0;
    return value / 4294967296;
  };
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
  if (cpu.isCpuId(clientId)) return { accountPlayerId: "", name: cpu.cpuName(clientId) };
  const profile = lobby?.memberProfiles?.get(clientId) || {};
  return {
    accountPlayerId: clean(profile.playerId, 64),
    name: clean(profile.displayName, 24, `Guest ${index + 1}`),
  };
}

// The bot seats a lobby fills at start. Humans always come first: a CPU only sits in a chair nobody
// claimed, so a host asking for six bots in a lobby that then fills with people gets none.
export function hideAndSeekCpuSeats(lobby) {
  const requested = Math.min(HIDE_AND_SEEK_MAX_CPU, Math.max(0, Math.floor(Number(lobby?.settings?.cpuCount) || 0)));
  const maxPlayers = Number(lobby?.maxPlayers) || HIDE_AND_SEEK_LOBBY_LIMITS.maxPlayers;
  return cpu.cpuSeatIds(requested, lobby?.members?.size || 0, maxPlayers);
}

export function createHideAndSeekMatchState(lobby, startAt) {
  const mapId = hideAndSeekMapId(lobby);
  const hotel = hotelPlan(mapId);
  const humanIds = [...(lobby?.members || [])];
  const cpuIds = hideAndSeekCpuSeats(lobby);
  const memberIds = [...humanIds, ...cpuIds];
  const seed = clean(lobby?.seed, 32, "seed");
  // Who is it is decided among the people. A bot at the keyboard of the seeker would make the round
  // a solo game the humans happen to be standing in.
  const seekerId = chooseSeeker(humanIds, seed);
  const space = sim.createPlanSpace({ plan, collision, hotel, config: CONFIG });
  const engine = sim.createSimulation({
    movement, round, stamina, flashlight, heat, fixtures, demon, enemy, layout,
    space, plan: hotel, zones: heatZones(hotel), random: seededRandom(seed),
    config: {
      // The map's demons, however many it has. Two was the hotel's number, not a rule — the roster
      // is the catalog's answer and this tick spawns, walks and catches for all of them.
      demons: maps.demonRosterFor(mapId),
      player: { ...CONFIG, floorCount: maps.floorCountFor(mapId) },
      round: ROUND_CONFIG,
      stamina: STAMINA_CONFIG,
      heat: HEAT_CONFIG,
      flashlight: FLASHLIGHT_CONFIG,
      fixtures: CONFIG,
      demon: CONFIG,
    },
  });
  const seats = seatPlayers(hotel, memberIds, seekerId, seed);
  // The bots' hands, off the same seeded random as the round, so a match with CPU guests in it still
  // replays from its inputs.
  const cpuDriver = cpuIds.length ? cpu.createDriverContext({
    hotel, space, catalog: engine.catalog, enemy, hiderLogic: hiders, demonLogic: demon, roundLogic: round,
    config: CONFIG, random: seededRandom(`${seed}:cpu`),
  }) : null;
  return {
    gameId: HIDE_AND_SEEK_GAME_ID,
    protocolVersion: HIDE_AND_SEEK_PROTOCOL_VERSION,
    mapId,
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
    // Presses no tick has read yet, keyed by client and holding the aim that rode with the press.
    // The tick is edge-triggered on `interact`, and this loop advances at snapshot cadence — a tap
    // is shorter than that window, so its release used to overwrite its press before any tick saw
    // it. A latched press is handed to exactly one tick, then the held input speaks for itself.
    presses: new Map(),
    cpuIds,
    cpuDriver,
    cpuBrains: cpuIds.map((id) => cpu.createHiderBrain(id)),
    profiles: new Map(memberIds.map((id, index) => [id, profileFor(lobby, id, index)])),
    // A bot never drops, so it is "connected" for the life of the match.
    connected: new Set(memberIds),
    lastAdvanceAt: Number(startAt) || Date.now(),
    snapshotTick: -1,
  };
}

// The only thing a client is allowed to say. `sim-logic.readInput` does the narrowing; anything else
// on the message — a position, a charge, a claim about a tag — never reaches the state.
export function applyHideAndSeekInput(match, clientId, value) {
  if (!match || cpu.isCpuId(clientId)) return false;
  if (!match.state.bodies.some((body) => body.id === clientId)) return false;
  const input = sim.readInput(value);
  const previous = match.inputs.get(clientId);
  if (input.interact && !previous?.interact) match.presses.set(clientId, input.interactId);
  match.inputs.set(clientId, input);
  return true;
}

// The inputs for one tick. A latched press is spent here: the tick sees the key down with the aim
// that came with it, and the next tick sees whatever the client last sent. If the previous tick
// already had the key down — a release and a new press both arrived since — this tick shows it up,
// so the authority's own edge can fire on the one after.
function inputsForTick(match) {
  const inputs = {};
  for (const [id, input] of match.inputs) {
    // A body nobody is driving stands still rather than repeating its last stride into a corridor.
    if (!match.connected.has(id)) { inputs[id] = sim.NO_INPUT; continue; }
    if (!match.presses.has(id)) { inputs[id] = input; continue; }
    const body = match.state.bodies.find((entry) => entry.id === id);
    if (body?.interacting) { inputs[id] = { ...input, interact: false }; continue; }
    inputs[id] = { ...input, interact: true, interactId: match.presses.get(id) };
    match.presses.delete(id);
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
  for (let tick = 0; tick < ticks; tick += 1) {
    const inputs = inputsForTick(match);
    // The bots read the world as it stands and press their keys for this tick, exactly where a
    // client's input would arrive. Their decisions never touch the state directly.
    if (match.cpuDriver) {
      const driven = cpu.driveHiders(match.cpuBrains, match.state, match.cpuDriver, STEP_SECONDS);
      match.cpuBrains = driven.brains;
      Object.assign(inputs, driven.inputs);
    }
    match.state = match.engine.tick(match.state, STEP_SECONDS, inputs);
  }
  if (match.engine.snapshot(match.state).round.over) match.phase = "complete";
  return match;
}

// The demons resolve their own catches inside the tick now. This stays because a round still has
// exactly one place it is allowed to end, and a dropped seeker has to end it the same way.
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
  match.presses.delete(clientId);
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
    // The building this round is in. A client that built a different one must refuse the round
    // rather than walk a body through walls it does not have.
    mapId: match.mapId,
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
    // The building's moving parts, the hunt, and the batteries on the floor. A client draws all of
    // this; it decides none of it.
    fixtures: snapshot.fixtures,
    demons: snapshot.demons,
    threat: snapshot.threat,
    pickups: snapshot.pickups,
    events: snapshot.events,
    players: snapshot.players.map((player) => ({
      ...player,
      name: match.profiles.get(player.id)?.name || "Guest",
      accountPlayerId: match.profiles.get(player.id)?.accountPlayerId || "",
      connected: match.connected.has(player.id),
      cpu: cpu.isCpuId(player.id),
    })),
  };
}
