// The online race on the wire: one definition of the snapshot, read by both
// sides of the mirror. The server writes it; a client applies it to the race it
// built from the same course, entrants and seed, and replays its own unacknowledged
// inputs on top (prediction) so its pet answers the keys with no round trip.

import { advanceRacer, readRaceInput } from "./race.js?v=20260928-pet-online";

export const BARNYARD_PROTOCOL_VERSION = 1;
export const BARNYARD_TICK_RATE = 60;

const r = (value, places) => {
  const scale = 10 ** places;
  return Math.round(Number(value) * scale) / scale;
};

/** A racer is sent as a short array: position, motion, progress, state. */
export function serializeRacer(racer) {
  return [
    racer.id,
    r(racer.x, 2), r(racer.y, 2), r(racer.angle, 4), r(racer.speed, 2),
    r(racer.jumpHeight, 3), r(racer.jumpVelocity, 3), racer.jumpHeld ? 1 : 0,
    racer.lap, racer.checkpoint,
    racer.finishedAt === null ? null : r(racer.finishedAt, 3),
    racer.dnf ? 1 : 0,
    racer.lastImpact ?? null,
  ];
}

export function serializeRace(race) {
  return {
    tick: race.tick,
    elapsed: r(race.elapsed, 3),
    countdown: r(race.countdown, 3),
    status: race.status,
    firstFinishAt: race.firstFinishAt === null ? null : r(race.firstFinishAt, 3),
    broken: [...race.brokenObstacles],
    racers: race.racers.map(serializeRacer),
  };
}

function applyRacer(local, row) {
  const [, x, y, angle, speed, jumpHeight, jumpVelocity, jumpHeld, lap, checkpoint, finishedAt, dnf, lastImpact] = row;
  return { ...local, x, y, angle, speed, jumpHeight, jumpVelocity, jumpHeld: jumpHeld === 1, lap, checkpoint, finishedAt, dnf: dnf === 1, lastImpact };
}

/** The server's word on the race, laid over a local copy built from the same entrants. */
export function applyRaceSnapshot(race, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.racers)) return race;
  const rows = new Map(snapshot.racers.map((row) => [row[0], row]));
  return {
    ...race,
    tick: snapshot.tick,
    elapsed: snapshot.elapsed,
    countdown: snapshot.countdown,
    status: snapshot.status,
    firstFinishAt: snapshot.firstFinishAt,
    brokenObstacles: Array.isArray(snapshot.broken) ? [...snapshot.broken] : race.brokenObstacles,
    racers: race.racers.map((racer) => (rows.has(racer.id) ? applyRacer(racer, rows.get(racer.id)) : racer)),
  };
}

/**
 * Replay this client's own inputs, oldest first, over its racer as the server
 * last saw it. The replay is the racer alone on the course — other pets are the
 * server's to place — which is exactly the part of a step one person's keys decide.
 */
export function predictRacer(race, racerId, inputs, dt = 1 / BARNYARD_TICK_RATE) {
  let racer = race.racers.find((entry) => entry.id === racerId);
  if (!racer || race.status !== "racing") return racer ?? null;
  let broken = race.brokenObstacles;
  for (const input of inputs) {
    const next = advanceRacer(racer, readRaceInput(input), dt, race.track, broken, race.totalLaps);
    racer = next.racer;
    broken = next.brokenObstacles;
  }
  return racer;
}
