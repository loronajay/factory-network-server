// Pondside Push: the authoritative online brawl.
//
// Clients send a direction and a bump a tick, each with a sequence number.
// Every shove, splash, round and match is produced here by the cabinet's own
// session.js (countdown, round, linger, next round), mirrored byte for byte
// under ../mirror. A client never states where its pet is or who fell in.
import { PONDSIDE_PROTOCOL_VERSION, serializeSession } from "../mirror/games/pondside-push/scripts/sim/net.js";
import { MAX_PETS, readPushInput } from "../mirror/games/pondside-push/scripts/sim/match.js";
import { createSession, matchStandings, retireSeat, stepSession } from "../mirror/games/pondside-push/scripts/sim/session.js";
import { clearInputs, cpuSeats, createInputQueue, humanSeats, owedTicks, pushInputs, takeInput } from "./pet-lobby-kit.mjs";

export const PONDSIDE_GAME_ID = "pondside-push";
export const PONDSIDE_LOBBY_LIMITS = Object.freeze({ minPlayers: 2, maxPlayers: MAX_PETS });

export function createPondsideMatch(lobby, startAt) {
  const humans = humanSeats(lobby);
  const cpus = cpuSeats(lobby, humans.length, PONDSIDE_LOBBY_LIMITS.maxPlayers);
  const seed = String(lobby?.seed ?? "seed");
  const session = createSession({
    entrants: [
      ...humans.map((seat) => ({ id: seat.seatId, pet: seat.pet })),
      ...cpus.map((seat) => ({ id: seat.seatId, pet: seat.pet, cpu: seat.level })),
    ],
    seed,
  });
  return {
    gameId: PONDSIDE_GAME_ID,
    protocolVersion: PONDSIDE_PROTOCOL_VERSION,
    seed,
    phase: "scheduled",
    startAt: Number(startAt) || Date.now(),
    lastAdvanceAt: Number(startAt) || Date.now(),
    session,
    seats: humans,
    cpus,
    seatByClient: new Map(humans.map((seat) => [seat.clientId, seat.seatId])),
    queues: new Map(humans.map((seat) => [seat.clientId, createInputQueue(readPushInput)])),
    connected: new Set(humans.map((seat) => seat.clientId)),
  };
}

export function applyPondsideInput(match, clientId, value) {
  const queue = match?.queues.get(clientId);
  if (!queue || match.phase === "complete") return false;
  pushInputs(queue, value);
  return true;
}

/** Advance to `now`. True the moment the match is over and has finished lingering. */
export function advancePondsideMatch(match, now = Date.now()) {
  if (!match || match.phase === "complete") return false;
  const ticks = owedTicks(match, now);
  for (let tick = 0; tick < ticks && match.session.phase !== "complete"; tick += 1) {
    const controls = {};
    for (const seat of match.seats) {
      const queue = match.queues.get(seat.clientId);
      controls[seat.seatId] = match.connected.has(seat.clientId) ? takeInput(queue) : readPushInput({});
    }
    stepSession(match.session, controls, 1 / 60);
  }
  if (match.session.phase === "complete") {
    match.phase = "complete";
    return true;
  }
  return false;
}

/** A dropped seat stands still for its grace window; a seat gone for good goes in the pond and stays there. */
export function applyPondsideDisconnect(match, clientId, stillSeated) {
  if (!match || !match.seatByClient.has(clientId)) return false;
  match.connected.delete(clientId);
  clearInputs(match.queues.get(clientId));
  if (!stillSeated && match.phase !== "complete") retireSeat(match.session, match.seatByClient.get(clientId));
  return true;
}

export function applyPondsideReconnect(match, clientId) {
  if (!match || !match.seatByClient.has(clientId) || match.connected.has(clientId)) return false;
  match.connected.add(clientId);
  return true;
}

export function pondsideResults(match) {
  const byId = new Map([...match.seats.map((seat) => [seat.seatId, seat]), ...match.cpus.map((seat) => [seat.seatId, seat])]);
  return matchStandings(match.session).map((player, index) => ({
    place: index + 1,
    seatId: player.id,
    human: !player.cpu,
    accountPlayerId: byId.get(player.id)?.accountPlayerId ?? "",
    name: byId.get(player.id)?.name ?? player.pet.name,
    wins: player.wins,
    left: player.left,
  }));
}

export function serializePondsideMatch(match, serverNow = Date.now()) {
  if (!match) return null;
  return {
    gameId: match.gameId,
    protocolVersion: match.protocolVersion,
    authorityMode: "server",
    phase: match.phase,
    seed: match.seed,
    startAt: match.startAt,
    serverNow,
    winsToMatch: match.session.match.winsToMatch,
    seats: match.seats.map((seat) => ({
      clientId: seat.clientId,
      seatId: seat.seatId,
      name: seat.name,
      accountPlayerId: seat.accountPlayerId,
      pet: seat.pet,
      connected: match.connected.has(seat.clientId),
    })),
    cpus: match.cpus.map((seat) => ({ seatId: seat.seatId, level: seat.level, pet: seat.pet })),
    acks: Object.fromEntries(match.seats.map((seat) => [seat.clientId, match.queues.get(seat.clientId).acked])),
    session: serializeSession(match.session),
    results: match.phase === "complete" ? pondsideResults(match) : null,
  };
}
