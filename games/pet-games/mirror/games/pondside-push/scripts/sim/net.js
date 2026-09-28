// The online brawl on the wire: one definition of the snapshot, read by both
// sides of the mirror. The server writes it; a client applies it to the session
// it built from the same entrants and seed, and replays its own unacknowledged
// inputs over its own pet (prediction) so movement answers with no round trip.

import { movePlayer, readPushInput } from "./match.js?v=20260928-pet-online";

export const PONDSIDE_PROTOCOL_VERSION = 1;
export const PONDSIDE_TICK_RATE = 60;

const r = (value, places) => {
  const scale = 10 ** places;
  return Math.round(Number(value) * scale) / scale;
};

const PLAYER_FIELDS = Object.freeze([
  ["x", 2], ["y", 2], ["vx", 2], ["vy", 2], ["facingX", 4], ["facingY", 4], ["momentum", 3],
  ["bumpTimer", 3], ["bumpCooldown", 3], ["bumpSourceSpeed", 2], ["impact", 3],
  ["fallHeight", 2], ["fallSpeed", 2], ["splashAge", 3],
]);

export function serializeSession(session) {
  const { match } = session;
  return {
    tick: session.tick,
    phase: session.phase,
    linger: r(session.linger, 3),
    countdown: { phase: session.countdown.phase, remaining: r(session.countdown.remaining, 3), complete: session.countdown.complete },
    match: {
      tick: match.tick,
      roundTicks: match.roundTicks,
      phase: match.phase,
      round: match.round,
      islandRadius: r(match.islandRadius, 2),
      roundWinnerId: match.roundWinnerId,
      matchWinnerId: match.matchWinnerId,
      players: match.players.map((player) => [
        player.id,
        ...PLAYER_FIELDS.map(([field, places]) => r(player[field], places)),
        player.wins,
        player.eliminated ? 1 : 0,
        player.left ? 1 : 0,
        [...player.bumpHits],
      ]),
    },
  };
}

/** The server's word on the match, laid over a local session built from the same entrants. */
export function applySessionSnapshot(session, snapshot) {
  if (!snapshot?.match || !Array.isArray(snapshot.match.players)) return session;
  const rows = new Map(snapshot.match.players.map((row) => [row[0], row]));
  session.tick = snapshot.tick;
  session.phase = snapshot.phase;
  session.linger = snapshot.linger;
  session.countdown = { ...snapshot.countdown };
  const { match } = session;
  Object.assign(match, {
    tick: snapshot.match.tick,
    roundTicks: snapshot.match.roundTicks,
    phase: snapshot.match.phase,
    round: snapshot.match.round,
    islandRadius: snapshot.match.islandRadius,
    roundWinnerId: snapshot.match.roundWinnerId,
    matchWinnerId: snapshot.match.matchWinnerId,
  });
  for (const player of match.players) {
    const row = rows.get(player.id);
    if (!row) continue;
    PLAYER_FIELDS.forEach(([field], index) => { player[field] = row[index + 1]; });
    const tail = PLAYER_FIELDS.length + 1;
    player.wins = row[tail];
    player.eliminated = row[tail + 1] === 1;
    player.left = row[tail + 2] === 1;
    player.bumpHits = Array.isArray(row[tail + 3]) ? [...row[tail + 3]] : [];
  }
  return session;
}

/**
 * Replay this client's own inputs, oldest first, over a copy of its pet as the
 * server last saw it: movement and bumps only — who hits whom is the server's.
 */
export function predictPlayer(session, playerId, inputs, dt = 1 / PONDSIDE_TICK_RATE) {
  const source = session.match.players.find((player) => player.id === playerId);
  if (!source) return null;
  const player = { ...source, bumpHits: [...source.bumpHits] };
  if (session.phase !== "playing" || player.eliminated) return player;
  for (const input of inputs) movePlayer(player, readPushInput(input), dt);
  return player;
}
