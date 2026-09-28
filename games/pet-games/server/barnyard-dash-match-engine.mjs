// Barnyard Dash: the authoritative online race.
//
// Clients send five booleans a tick (throttle, brake, left, right, jump), each
// with a sequence number. The race — every position, every hurdle cleared or
// clipped, every gate smashed, every checkpoint and the finishing order — is
// produced here by the cabinet's own race.js, mirrored byte for byte under
// ../mirror. A client never states where its pet is or when it finished.
import { courseForSeed, findCourse } from "../mirror/games/barnyard-dash/scripts/sim/courses.js";
import { BARNYARD_PROTOCOL_VERSION, serializeRace } from "../mirror/games/barnyard-dash/scripts/sim/net.js";
import { createRace, raceOrder, readRaceInput, retireRacer, stepRace } from "../mirror/games/barnyard-dash/scripts/sim/race.js";
import { clearInputs, cpuSeats, createInputQueue, humanSeats, owedTicks, pushInputs, takeInput } from "./pet-lobby-kit.mjs";

export const BARNYARD_GAME_ID = "barnyard-dash";
export const BARNYARD_LOBBY_LIMITS = Object.freeze({ minPlayers: 2, maxPlayers: 8 });
const COUNTDOWN_SECONDS = 3;

/** The course a room races: the host's pick, or for a quick room one drawn from the seed. */
export function courseForLobby(lobby) {
  return findCourse(lobby?.settings?.mapId) ?? courseForSeed(lobby?.seed ?? "seed");
}

export function createBarnyardMatch(lobby, startAt) {
  const humans = humanSeats(lobby);
  const cpus = cpuSeats(lobby, humans.length, BARNYARD_LOBBY_LIMITS.maxPlayers);
  const course = courseForLobby(lobby);
  const seed = String(lobby?.seed ?? "seed");
  const race = createRace({
    track: course.track,
    entrants: [
      ...humans.map((seat) => ({ id: seat.seatId, pet: seat.pet })),
      ...cpus.map((seat) => ({ id: seat.seatId, pet: seat.pet, cpu: seat.level })),
    ],
    countdownSeconds: COUNTDOWN_SECONDS,
    totalLaps: course.laps,
    seed,
  });
  return {
    gameId: BARNYARD_GAME_ID,
    protocolVersion: BARNYARD_PROTOCOL_VERSION,
    courseId: course.id,
    seed,
    phase: "scheduled",
    startAt: Number(startAt) || Date.now(),
    lastAdvanceAt: Number(startAt) || Date.now(),
    race,
    seats: humans,
    cpus,
    seatByClient: new Map(humans.map((seat) => [seat.clientId, seat.seatId])),
    queues: new Map(humans.map((seat) => [seat.clientId, createInputQueue(readRaceInput)])),
    connected: new Set(humans.map((seat) => seat.clientId)),
  };
}

/** A person's keys, and only theirs: a client can drive no seat but its own. */
export function applyBarnyardInput(match, clientId, value) {
  const queue = match?.queues.get(clientId);
  if (!queue || match.phase === "complete") return false;
  pushInputs(queue, value);
  return true;
}

/** Advance to `now`. True the moment the race is over. */
export function advanceBarnyardMatch(match, now = Date.now()) {
  if (!match || match.phase === "complete") return false;
  const ticks = owedTicks(match, now);
  for (let tick = 0; tick < ticks && match.race.status !== "finished"; tick += 1) {
    const controls = {};
    for (const seat of match.seats) {
      const queue = match.queues.get(seat.clientId);
      controls[seat.seatId] = match.connected.has(seat.clientId) ? takeInput(queue) : readRaceInput({});
    }
    match.race = stepRace(match.race, controls, 1 / 60);
  }
  if (match.race.status === "finished") {
    match.phase = "complete";
    return true;
  }
  return false;
}

/**
 * A seat that drops lets go of its keys and coasts while the grace window runs;
 * a seat that has left for good is out of the race (it keeps its place by progress).
 */
export function applyBarnyardDisconnect(match, clientId, stillSeated) {
  if (!match || !match.seatByClient.has(clientId)) return false;
  match.connected.delete(clientId);
  clearInputs(match.queues.get(clientId));
  if (!stillSeated) match.race = retireRacer(match.race, match.seatByClient.get(clientId));
  if (match.race.status === "finished") match.phase = "complete";
  return true;
}

export function applyBarnyardReconnect(match, clientId) {
  if (!match || !match.seatByClient.has(clientId) || match.connected.has(clientId)) return false;
  match.connected.add(clientId);
  return true;
}

/** The finishing order with who each seat is — what a client files as its result. */
export function barnyardResults(match) {
  const byId = new Map([...match.seats.map((seat) => [seat.seatId, seat]), ...match.cpus.map((seat) => [seat.seatId, seat])]);
  return raceOrder(match.race).map((racer, index) => ({
    place: index + 1,
    seatId: racer.id,
    human: racer.human,
    accountPlayerId: byId.get(racer.id)?.accountPlayerId ?? "",
    name: byId.get(racer.id)?.name ?? racer.pet.name,
    finishedAt: racer.finishedAt,
    dnf: racer.dnf,
  }));
}

export function serializeBarnyardMatch(match, serverNow = Date.now()) {
  if (!match) return null;
  return {
    gameId: match.gameId,
    protocolVersion: match.protocolVersion,
    authorityMode: "server",
    phase: match.phase,
    courseId: match.courseId,
    seed: match.seed,
    startAt: match.startAt,
    serverNow,
    totalLaps: match.race.totalLaps,
    // Who is in which seat, and what they are racing — enough for a client to build the same race.
    seats: match.seats.map((seat) => ({
      clientId: seat.clientId,
      seatId: seat.seatId,
      name: seat.name,
      accountPlayerId: seat.accountPlayerId,
      pet: seat.pet,
      connected: match.connected.has(seat.clientId),
    })),
    cpus: match.cpus.map((seat) => ({ seatId: seat.seatId, level: seat.level, pet: seat.pet })),
    // The last input the tick took from each person, so each can replay only what is newer.
    acks: Object.fromEntries(match.seats.map((seat) => [seat.clientId, match.queues.get(seat.clientId).acked])),
    race: serializeRace(match.race),
    results: match.phase === "complete" ? barnyardResults(match) : null,
  };
}
