// Bird Duty: the authoritative match.
//
// This server owns the match. Clients send **inputs** — three booleans, `left`, `right` and `drop` —
// and receive snapshots; they never report a position, a score, a hit or a winner. Every rule that
// turns those inputs into a match lives in `../shared/sim/`, which is a byte-for-byte mirror of the
// cabinet's pure layer, so "who scored" is answered by the same code in both places.
//
// This replaced a host-authoritative arrangement, where whichever browser created the lobby ran the
// match and told everyone else the result. That gave one player the ability to adjudicate their own
// score, and it made the match die with their tab. Neither is acceptable for a competitive game, and
// neither is fixable by migrating the host — the fix is that there is no host.
import {
  BIRD_DUTY_PROTOCOL_VERSION,
  BIRD_DUTY_TICK_RATE,
  applyMatchSimInput,
  clearMatchSimInput,
  createMatchSimState,
  forfeitMatchSimTurn,
  isMatchSimComplete,
  isMatchSimFinished,
  matchSimActivePlayerId,
  matchSimHasPlayer,
  serializeMatchSim,
  tickMatchSim,
  HOTSEAT_ROUNDS,
} from "../shared/index.mjs";

export const BIRD_DUTY_GAME_ID = "bird-duty";
export const BIRD_DUTY_RECONNECT_GRACE_MS = 20_000;
// Gameplay is the cabinet's fixed 60hz tick. Snapshots go out far less often; the bird, the poop and
// the walkers all move smoothly between them on the client, which predicts presentation only.
export const BIRD_DUTY_SNAPSHOT_HZ = 20;
// A stalled process must not replay ten seconds of match in one frame.
const MAX_TICKS_PER_ADVANCE = 12;
const MS_PER_TICK = 1000 / BIRD_DUTY_TICK_RATE;

// Bird Duty is a hot-seat match played over the wire: two to four birds take turns.
export const BIRD_DUTY_LOBBY_LIMITS = Object.freeze({ minPlayers: 2, maxPlayers: 4 });

function clean(value, max, fallback = "") {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, max);
}

function seatPlayers(lobby) {
  const memberIds = [...(lobby?.members || [])];
  return memberIds.map((clientId, index) => {
    const profile = lobby?.memberProfiles?.get(clientId) || {};
    return {
      clientId,
      name: clean(profile.displayName, 18, `Player ${index + 1}`),
      accountPlayerId: clean(profile.playerId, 64),
    };
  });
}

export function createBirdDutyMatchState(lobby, startAt) {
  const players = seatPlayers(lobby);
  return {
    gameId: BIRD_DUTY_GAME_ID,
    protocolVersion: BIRD_DUTY_PROTOCOL_VERSION,
    roomCode: clean(lobby?.roomCode, 8),
    authorityMode: "server",
    phase: "scheduled",
    seed: clean(lobby?.seed, 32, "seed"),
    startAt: Number(startAt) || Date.now(),
    tickRate: BIRD_DUTY_TICK_RATE,
    sim: createMatchSimState({ players }),
    profiles: new Map(players.map((player) => [player.clientId, player])),
    connected: new Set(players.map((player) => player.clientId)),
    lastAdvanceAt: Number(startAt) || Date.now(),
  };
}

/**
 * The only thing a client is allowed to say.
 *
 * `readMatchSimInput` inside the sim does the narrowing; anything else on the message — a score, an
 * x, a claim about a hit — never reaches the state. A seat that is not this client's is refused
 * outright, so nobody can drive another player's bird.
 */
export function applyBirdDutyInput(match, clientId, value) {
  if (!match || !matchSimHasPlayer(match.sim, clientId)) return false;
  match.sim = applyMatchSimInput(match.sim, clientId, value);
  return true;
}

export function advanceBirdDutyMatch(match, now = Date.now()) {
  if (!match || match.phase === "complete") return match;
  if (now < match.startAt) return match;
  if (match.phase === "scheduled") {
    match.phase = "active";
    match.lastAdvanceAt = match.startAt;
  }

  const owed = Math.floor((now - match.lastAdvanceAt) / MS_PER_TICK);
  const ticks = Math.min(Math.max(0, owed), MAX_TICKS_PER_ADVANCE);
  // A process that stalled longer than the cap gives up the debt rather than fast-forwarding the
  // match; catching up would spend a player's shots for them.
  if (owed > ticks) match.lastAdvanceAt = now;
  else match.lastAdvanceAt += ticks * MS_PER_TICK;

  for (let tick = 0; tick < ticks; tick += 1) match.sim = tickMatchSim(match.sim);

  if (isMatchSimFinished(match.sim)) match.phase = "complete";
  return match;
}

/**
 * A seat that drops stops driving, and if it was that seat's turn, the turn is forfeited.
 *
 * The forfeit is the load-bearing half. A Bird Duty turn ends when its magazine is empty, and only
 * the player holding the turn can spend it — so a seat that walks away mid-turn would hold the match
 * open forever with everybody else locked out, unable to act because it is not their turn. Under the
 * old host-authoritative arrangement this was hidden behind a worse problem (the match died with the
 * host's tab); with the match living here, it is the case that has to be handled.
 *
 * There is nothing to migrate: the match was never running in anybody's browser.
 */
export function applyBirdDutyDisconnect(match, clientId, now = Date.now()) {
  if (!match || !match.connected.has(clientId)) return false;
  match.connected.delete(clientId);
  match.sim = clearMatchSimInput(match.sim, clientId);
  match.lastDisconnectAt = now;

  // A match with nobody left to play it is over rather than ticking on empty.
  if (match.connected.size === 0) {
    match.phase = "complete";
    return true;
  }

  skipAbsentSeats(match);
  return true;
}

/**
 * Hand the turn on until it reaches somebody who is actually here.
 *
 * Bounded by the number of turns a match has, because a forfeit always advances the seat and the
 * match ends after the last one — but the bound is written down rather than assumed, since this
 * loop runs inside a socket handler and a spin here would take the whole server with it.
 */
function skipAbsentSeats(match) {
  const seats = Math.max(1, match.sim.match.players.length) * HOTSEAT_ROUNDS + 1;
  for (let guard = 0; guard < seats; guard += 1) {
    const activeId = matchSimActivePlayerId(match.sim);
    if (!activeId || match.connected.has(activeId)) return;
    if (isMatchSimComplete(match.sim)) return;
    match.sim = forfeitMatchSimTurn(match.sim, activeId);
  }
}

export function applyBirdDutyReconnect(match, clientId) {
  if (!match || match.connected.has(clientId)) return false;
  if (!matchSimHasPlayer(match.sim, clientId)) return false;
  match.connected.add(clientId);
  return true;
}

/**
 * Shape the wire snapshot.
 *
 * The sim's sound queue is drained here rather than by ticking: sounds happen at 60hz and snapshots
 * leave at 20hz, so a voice line from a skipped tick must still ride out on the next snapshot, and
 * must not ride out twice.
 */
export function serializeBirdDutyMatch(match, serverNow = Date.now()) {
  if (!match) return null;
  const { snapshot, drained } = serializeMatchSim(match.sim);
  match.sim = drained;
  return {
    gameId: match.gameId,
    roomCode: match.roomCode,
    authorityMode: match.authorityMode,
    phase: match.phase,
    seed: match.seed,
    startAt: match.startAt,
    serverNow,
    complete: isMatchSimComplete(match.sim),
    activeClientId: matchSimActivePlayerId(match.sim),
    ...snapshot,
    match: {
      ...snapshot.match,
      players: snapshot.match.players.map((player) => ({
        ...player,
        accountPlayerId: match.profiles.get(player.clientId)?.accountPlayerId || "",
        connected: match.connected.has(player.clientId),
      })),
    },
  };
}
