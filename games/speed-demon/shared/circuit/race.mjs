// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/circuit/race.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

import { resolveTrackCollision } from "./collision.mjs";
import { createCpuDriver, updateCpuDriver } from "./cpu-driver.mjs";
import { circuitDifficultyById, cpuVehicleTuningFor } from "./difficulty.mjs";
import { clamp } from "./math.mjs";
import { createVehicle, stepVehicle } from "./vehicle.mjs";
import { resolveVehicleCollision } from "./vehicle-collision.mjs";

export const STATUS_COUNTDOWN = "countdown";
export const STATUS_RACING = "racing";
export const STATUS_FINISHED = "finished";

const validControl = (control) => ["local", "cpu", "remote"].includes(control);

function normalizeParticipant(entry, index, track, cpuDifficultyId) {
  const modelId = String(entry?.modelId ?? "");
  if (!modelId) throw new Error("Circuit participant requires modelId");
  const spawn = track.spawns[index % track.spawns.length];
  const control = validControl(entry?.control) ? entry.control : "cpu";
  return {
    playerId: String(entry?.playerId ?? `participant-${index + 1}`),
    displayName: String(entry?.displayName ?? entry?.playerId ?? `DRIVER ${index + 1}`),
    control,
    modelId,
    livery: entry?.livery ?? null,
    vehicle: createVehicle(spawn),
    input: { throttle: 0, brake: 0, steer: 0, shift: 0 },
    driver: control === "cpu" ? createCpuDriver(track.racingLine, 1, cpuDifficultyId) : null,
    nextCheckpoint: track.checkpoints.length > 1 ? 1 : 0,
    checkpointsPassed: 0,
    lap: 0,
    lapStartedAt: 0,
    lapTimes: [],
    lastLapTime: null,
    bestLapTime: null,
    finishedAt: null,
    place: null,
  };
}

export function createCircuitRace(definition, track) {
  if (definition?.runtime !== "circuit") throw new Error("Circuit race requires runtime 'circuit'");
  if (!track || track.id !== definition.trackId) throw new Error(`Unknown circuit track '${definition?.trackId}'`);
  if (!Array.isArray(definition.participants) || definition.participants.length === 0) {
    throw new Error("Circuit race requires participants");
  }
  const laps = Math.max(1, Math.min(99, Math.trunc(definition.rules?.laps ?? 3)));
  const countdownSeconds = Math.max(0, Math.min(10, Number(definition.rules?.countdownSeconds ?? 3)));
  const timeoutSeconds = Math.max(10, Math.min(1800, Number(definition.rules?.timeoutSeconds ?? 300)));
  const cpuDifficultyId = circuitDifficultyById(definition.rules?.cpuDifficultyId).id;
  // "local": the race is over the moment the local driver crosses the line,
  // whatever the CPU is still doing. "all": it runs until every driver is home
  // — the online shape, where the server holds the flag and both clients keep
  // predicting the other car's last lap.
  const finishRule = definition.rules?.finishRule === "all" ? "all" : "local";
  return {
    runtime: "circuit",
    modeId: definition.modeId ?? "circuit",
    trackId: track.id,
    rules: { laps, countdownSeconds, timeoutSeconds, cpuDifficultyId, finishRule },
    source: {
      kind: definition.source?.kind ?? "freeplay",
      id: definition.source?.id ?? null,
    },
    status: countdownSeconds > 0 ? STATUS_COUNTDOWN : STATUS_RACING,
    countdown: countdownSeconds,
    elapsed: 0,
    tick: 0,
    participants: definition.participants.map((entry, index) => (
      normalizeParticipant(entry, index, track, cpuDifficultyId)
    )),
    finishOrder: [],
    lastEvents: [],
  };
}

export function inputCircuitRace(state, action = {}) {
  const playerId = String(action.playerId ?? "");
  return {
    ...state,
    participants: state.participants.map((participant) => participant.playerId === playerId
      ? {
        ...participant,
        input: {
          throttle: clamp(Number(action.throttle) || 0, -1, 1),
          brake: clamp(Number(action.brake) || 0, 0, 1),
          steer: clamp(Number(action.steer) || 0, -1, 1),
          shift: Math.sign(Number(action.shift) || 0),
        },
      }
      : participant),
  };
}

function crossesCircle(previous, current, checkpoint) {
  const dx = current.x - previous.x;
  const dy = current.y - previous.y;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared > 0
    ? clamp(((checkpoint.x - previous.x) * dx + (checkpoint.y - previous.y) * dy) / lengthSquared, 0, 1)
    : 0;
  const x = previous.x + dx * projection;
  const y = previous.y + dy * projection;
  return Math.hypot(x - checkpoint.x, y - checkpoint.y) <= checkpoint.radius;
}

function advanceParticipant(participant, previousVehicle, track, rules, elapsed, place) {
  if (participant.finishedAt !== null || track.checkpoints.length === 0) return { participant, event: null };
  const checkpoint = track.checkpoints[participant.nextCheckpoint];
  if (!checkpoint || !crossesCircle(previousVehicle, participant.vehicle, checkpoint)) {
    return { participant, event: null };
  }
  const completedIndex = participant.nextCheckpoint;
  const nextCheckpoint = (completedIndex + 1) % track.checkpoints.length;
  let lap = participant.lap;
  let finishedAt = participant.finishedAt;
  let finishPlace = participant.place;
  let lapStartedAt = participant.lapStartedAt;
  let lapTimes = participant.lapTimes;
  let lastLapTime = participant.lastLapTime;
  let bestLapTime = participant.bestLapTime;
  let event = { type: "checkpoint", playerId: participant.playerId, checkpoint: completedIndex };
  if (completedIndex === 0) {
    lap += 1;
    lastLapTime = Math.max(0, elapsed - participant.lapStartedAt);
    bestLapTime = participant.bestLapTime === null
      ? lastLapTime
      : Math.min(participant.bestLapTime, lastLapTime);
    lapTimes = [...participant.lapTimes, lastLapTime];
    lapStartedAt = elapsed;
    event = { type: "lap", playerId: participant.playerId, lap, lapTime: lastLapTime };
    if (lap >= rules.laps) {
      finishedAt = elapsed;
      finishPlace = place;
      event = { type: "finish", playerId: participant.playerId, place, time: elapsed };
    }
  }
  return {
    participant: {
      ...participant,
      nextCheckpoint,
      checkpointsPassed: participant.checkpointsPassed + 1,
      lap,
      lapStartedAt,
      lapTimes,
      lastLapTime,
      bestLapTime,
      finishedAt,
      place: finishPlace,
    },
    event,
  };
}

function stepParticipants(state, dt, track, containsVehicle) {
  const previous = state.participants.map((participant) => participant.vehicle);
  let participants = state.participants.map((participant) => {
    if (participant.finishedAt !== null) return participant;
    let input = participant.input;
    let driver = participant.driver;
    if (participant.control === "cpu") {
      const difficulty = circuitDifficultyById(driver.difficultyId);
      const decision = updateCpuDriver(driver, participant.vehicle, difficulty.driver);
      input = decision.input;
      driver = decision.driver;
    }
    const tuning = participant.control === "cpu" ? cpuVehicleTuningFor(driver.difficultyId) : undefined;
    const driveInput = { ...input, throttle: input.brake > 0 ? -input.brake : input.throttle };
    const candidate = stepVehicle(participant.vehicle, driveInput, dt, tuning);
    const collision = resolveTrackCollision(participant.vehicle, candidate, containsVehicle);
    return { ...participant, input, driver, vehicle: collision.vehicle };
  });

  for (let left = 0; left < participants.length; left += 1) {
    for (let right = left + 1; right < participants.length; right += 1) {
      const contact = resolveVehicleCollision(participants[left].vehicle, participants[right].vehicle);
      if (!contact.impact) continue;
      participants[left] = {
        ...participants[left],
        vehicle: containsVehicle(contact.player) ? contact.player : participants[left].vehicle,
      };
      participants[right] = {
        ...participants[right],
        vehicle: containsVehicle(contact.cpu) ? contact.cpu : participants[right].vehicle,
      };
    }
  }
  return { participants, previous };
}

export function stepCircuitRace(state, dt, environment = {}) {
  if (state.status === STATUS_FINISHED) return state;
  const safeDt = clamp(Number(dt) || 0, 0, 0.05);
  if (state.status === STATUS_COUNTDOWN) {
    const countdown = Math.max(0, state.countdown - safeDt);
    return {
      ...state,
      countdown,
      tick: state.tick + 1,
      status: countdown === 0 ? STATUS_RACING : STATUS_COUNTDOWN,
      lastEvents: countdown === 0 ? [{ type: "start" }] : [],
    };
  }

  const track = environment.track;
  if (!track) throw new Error("Circuit step requires its track environment");
  const containsVehicle = environment.containsVehicle ?? (() => true);
  const elapsed = state.elapsed + safeDt;
  const stepped = stepParticipants(state, safeDt, track, containsVehicle);
  const finishOrder = [...state.finishOrder];
  const lastEvents = [];
  const participants = stepped.participants.map((participant, index) => {
    const place = finishOrder.length + 1;
    const advanced = advanceParticipant(
      participant,
      stepped.previous[index],
      track,
      state.rules,
      elapsed,
      place,
    );
    if (advanced.event) lastEvents.push(advanced.event);
    if (advanced.event?.type === "finish") finishOrder.push(participant.playerId);
    return advanced.participant;
  });
  const timedOut = elapsed >= state.rules.timeoutSeconds;
  const local = state.rules.finishRule === "all"
    ? null
    : participants.find((participant) => participant.control === "local") ?? null;
  const complete = timedOut || (local
    ? local.finishedAt !== null
    : participants.every((participant) => participant.finishedAt !== null));
  if (timedOut) lastEvents.push({ type: "timeout" });
  return {
    ...state,
    elapsed,
    tick: state.tick + 1,
    participants,
    finishOrder,
    lastEvents,
    status: complete ? STATUS_FINISHED : STATUS_RACING,
  };
}

export function circuitRaceResult(state, playerId = "local") {
  const participant = state.participants.find((entry) => entry.playerId === playerId) ?? null;
  const winner = state.participants.find((entry) => entry.place === 1)
    ?? state.participants.find((entry) => entry.playerId === state.finishOrder[0])
    ?? null;
  const finished = participant?.finishedAt !== null && participant?.finishedAt !== undefined;
  const won = participant?.place === 1;
  return {
    won,
    outcome: won ? "victory" : "defeat",
    value: finished ? participant.finishedAt : null,
    better: "lower",
    place: participant?.place ?? null,
    finished,
    fieldSize: state.participants.length,
    laps: state.rules.laps,
    winnerId: winner?.playerId ?? null,
    winnerName: winner?.displayName ?? winner?.playerId ?? null,
    playerName: participant?.displayName ?? participant?.playerId ?? null,
  };
}
