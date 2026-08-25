import {
  CIRCUIT_FIXED_STEP,
  CIRCUIT_MODEL_IDS,
  applyCircuitInput,
  circuitSnapshot,
  createCircuitRace,
  stepCircuitRace,
} from "../shared/circuit-race.mjs";
import { loadCircuitRoadMask } from "../shared/circuit-road-mask.mjs";
import { DEFAULT_CIRCUIT_TRACK_ID, circuitTrackById } from "../shared/circuit-tracks.mjs";

const roadMasks = new Map();
const MAX_FUTURE_TICKS = 90;

export const circuitLoadoutAvailable = (player) => CIRCUIT_MODEL_IDS.includes(player?.modelId);

export function createAuthoritativeCircuitRound({ players, laps = 3, trackId = DEFAULT_CIRCUIT_TRACK_ID } = {}) {
  if (!players?.every(circuitLoadoutAvailable)) throw new Error("CIRCUIT_ATLAS_UNAVAILABLE");
  const track = circuitTrackById(trackId) ?? circuitTrackById(DEFAULT_CIRCUIT_TRACK_ID);
  if (!roadMasks.has(track.id)) roadMasks.set(track.id, loadCircuitRoadMask(track.id));
  const roadMask = roadMasks.get(track.id);
  let race = createCircuitRace({ players, laps, track });
  const queues = new Map(players.map((player) => [player.playerId, new Map()]));

  function receive(playerId, events = []) {
    const queue = queues.get(playerId);
    if (!queue) return { accepted: [], rejected: events.length };
    const accepted = [];
    for (const event of events) {
      const tick = Math.trunc(Number(event?.t));
      if (!Number.isFinite(tick) || tick < race.tick || tick > race.tick + MAX_FUTURE_TICKS) continue;
      const normalized = {
        t: tick,
        throttle: Number(event.throttle) || 0,
        brake: Number(event.brake) || 0,
        steer: Number(event.steer) || 0,
        shift: Number(event.shift) || 0,
      };
      queue.set(tick, normalized);
      accepted.push(normalized);
    }
    return { accepted, rejected: events.length - accepted.length };
  }

  function advance(targetTick) {
    const goal = Math.max(race.tick, Math.trunc(Number(targetTick) || race.tick));
    while (race.tick < goal && race.status !== "finished") {
      for (const [playerId, queue] of queues) {
        const input = queue.get(race.tick);
        if (input) race = applyCircuitInput(race, playerId, input);
        queue.delete(race.tick);
      }
      race = stepCircuitRace(race, roadMask.containsVehicle, track);
    }
    return circuitSnapshot(race);
  }

  return {
    receive,
    advance,
    snapshot: () => circuitSnapshot(race),
    get finished() { return race.status === "finished"; },
    get results() {
      return race.participants.map((participant) => ({
        playerId: participant.playerId,
        finishTime: participant.finishedAt,
        complete: participant.finishedAt !== null,
        place: participant.place,
      }));
    },
  };
}

export const ticksForElapsedMs = (elapsedMs) => Math.max(0, Math.floor(elapsedMs / 1000 / CIRCUIT_FIXED_STEP));
