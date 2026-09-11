// The authoritative circuit round: the cabinet's own pure circuit reducer,
// mirrored byte-for-byte under ../shared/circuit/, driven by tick-stamped
// inputs and read back as snapshots.
//
// Nothing about the physics lives here. A hand-written server copy of the
// reducer once did, and it drifted (no wall-separation nudge, a roster eight
// cars behind), which put the server's car a little way from every client's
// prediction on the first barrier scrape and never let them agree again. This
// file only decides *when* a tick runs and *which* input it sees.

import {
  createCircuitRace,
  inputCircuitRace,
  stepCircuitRace,
  STATUS_FINISHED,
} from "../shared/circuit/race.mjs";
import { hasCircuitAtlas } from "../shared/circuit/assets.mjs";
import { CIRCUIT_FIXED_STEP } from "../shared/circuit/config.mjs";
import { loadCircuitRoadMask } from "../shared/circuit-road-mask.mjs";
import { DEFAULT_CIRCUIT_TRACK_ID, circuitTrackById } from "../shared/circuit/tracks.mjs";

const roadMasks = new Map();

/**
 * An input may claim a tick this far past the one the server is on. The client
 * runs ahead of the server by design (see CIRCUIT_INPUT_DELAY_MS), so "early"
 * here is early beyond any honest clock offset plus that lead.
 */
export const MAX_FUTURE_TICKS = 180;

/**
 * Once the first driver is home the other gets this long to finish. Without it
 * a driver who parks — or whose tab is gone — holds the round open for the full
 * five-minute timeout with the winner staring at the flag.
 */
export const CIRCUIT_FLAG_SECONDS = 30;

export const circuitLoadoutAvailable = (player) => hasCircuitAtlas(player?.modelId);

export function createAuthoritativeCircuitRound({
  players,
  laps = 3,
  trackId = DEFAULT_CIRCUIT_TRACK_ID,
  countdownSeconds = 3,
} = {}) {
  if (!players?.every(circuitLoadoutAvailable)) throw new Error("CIRCUIT_ATLAS_UNAVAILABLE");
  const track = circuitTrackById(trackId) ?? circuitTrackById(DEFAULT_CIRCUIT_TRACK_ID);
  if (!roadMasks.has(track.id)) roadMasks.set(track.id, loadCircuitRoadMask(track.id));
  const roadMask = roadMasks.get(track.id);
  const environment = { track, containsVehicle: (vehicle) => roadMask.containsVehicle(vehicle) };

  // The same definition a client builds for the round — every field the sim
  // reads has to agree or the prediction is wrong before the first input.
  // `finishRule: "all"` is what makes this a race the server ends rather than
  // one each client ends for itself the moment its own car is home.
  let race = createCircuitRace({
    runtime: "circuit",
    modeId: "circuit",
    trackId: track.id,
    rules: { laps, countdownSeconds, timeoutSeconds: 300, finishRule: "all" },
    participants: players.map((player) => ({
      playerId: player.playerId,
      displayName: player.displayName,
      control: "remote",
      modelId: player.modelId,
      livery: player.livery ?? null,
    })),
    source: { kind: "online", id: null },
  }, track);

  // Per driver, the input to apply at each tick. An input for a tick the sim
  // has already passed is not thrown away — it is applied at the tick the sim
  // is on, because a steer that arrives late is still what the driver's hands
  // are doing now. Dropping it left the server holding a stale input until the
  // next packet, and every steer change became a visible correction.
  const queues = new Map(players.map((player) => [player.playerId, new Map()]));

  function receive(playerId, events = []) {
    const queue = queues.get(playerId);
    if (!queue) return { accepted: [], rejected: events.length };
    const accepted = [];
    for (const event of events) {
      const claimed = Math.trunc(Number(event?.t));
      if (!Number.isFinite(claimed) || claimed > race.tick + MAX_FUTURE_TICKS) continue;
      const tick = Math.max(claimed, race.tick);
      const existing = queue.get(tick);
      // Two late inputs collapsing onto the current tick: the later-claimed one
      // is the driver's more recent intent and wins.
      if (existing && existing.claimed > claimed) continue;
      const normalized = {
        t: tick,
        claimed,
        throttle: Number(event.throttle) || 0,
        brake: Number(event.brake) || 0,
        steer: Number(event.steer) || 0,
        shift: Number(event.shift) || 0,
      };
      queue.set(tick, normalized);
      accepted.push({ t: tick, throttle: normalized.throttle, brake: normalized.brake, steer: normalized.steer, shift: normalized.shift });
    }
    return { accepted, rejected: events.length - accepted.length };
  }

  function advance(targetTick) {
    const goal = Math.max(race.tick, Math.trunc(Number(targetTick) || race.tick));
    while (race.tick < goal && race.status !== STATUS_FINISHED) {
      for (const [playerId, queue] of queues) {
        const input = queue.get(race.tick);
        if (input) race = inputCircuitRace(race, { playerId, ...input });
        queue.delete(race.tick);
      }
      race = applyCircuitFlag(stepCircuitRace(race, CIRCUIT_FIXED_STEP, environment));
    }
    return circuitSnapshot(race);
  }

  return {
    receive,
    advance,
    snapshot: () => circuitSnapshot(race),
    get finished() { return race.status === STATUS_FINISHED; },
    get results() {
      return race.participants.map((participant) => ({
        playerId: participant.playerId,
        displayName: participant.displayName,
        finishTime: participant.finishedAt,
        complete: participant.finishedAt !== null,
        place: participant.place,
        lapTimes: participant.lapTimes,
        bestLapTime: participant.bestLapTime,
      }));
    },
  };
}

/**
 * The chequered flag: once the first driver is home and CIRCUIT_FLAG_SECONDS
 * have passed, the race is over for everyone still out. This is the one rule
 * the server applies that the cabinet's reducer does not — a client cannot
 * know when the server called it, and does not need to, because the verdict
 * arrives as a round result rather than as a predicted state.
 */
export function applyCircuitFlag(race, flagSeconds = CIRCUIT_FLAG_SECONDS) {
  if (race.status === STATUS_FINISHED || race.finishOrder.length === 0) return race;
  const first = race.participants.find((participant) => participant.playerId === race.finishOrder[0]);
  if (!first || first.finishedAt === null) return race;
  return race.elapsed - first.finishedAt >= flagSeconds ? { ...race, status: STATUS_FINISHED } : race;
}

/**
 * The wire shape of the race. Everything a client's reconcile overwrites is
 * here; what is not (model, livery, name, the CPU driver) never changes during
 * a round and the client already holds it.
 */
export function circuitSnapshot(state) {
  return {
    runtime: state.runtime,
    trackId: state.trackId,
    tick: state.tick,
    elapsed: state.elapsed,
    countdown: state.countdown,
    status: state.status,
    finishOrder: [...state.finishOrder],
    participants: state.participants.map(({
      playerId, vehicle, input, nextCheckpoint, checkpointsPassed, lap, lapStartedAt,
      lapTimes, lastLapTime, bestLapTime, finishedAt, place,
    }) => ({
      playerId,
      vehicle: { ...vehicle },
      input: { ...input },
      nextCheckpoint,
      checkpointsPassed,
      lap,
      lapStartedAt,
      lapTimes: [...lapTimes],
      lastLapTime,
      bestLapTime,
      finishedAt,
      place,
    })),
  };
}

export const ticksForElapsedMs = (elapsedMs) => Math.max(0, Math.floor(elapsedMs / 1000 / CIRCUIT_FIXED_STEP));
