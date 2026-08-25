// Mirrored from the cabinet's pure Circuit Race reducer. Keep this module free
// of sockets, clocks, images and canvas so a recorded input stream produces the
// same authoritative state in the browser and on the server.

import { OLD_TOWN_SHRINE_TRACK } from "./circuit-tracks.mjs";

export const CIRCUIT_FIXED_STEP = 1 / 120;
export const CIRCUIT_MODEL_IDS = Object.freeze([
  "kaido-gts", "tsunami-rz", "meridian-rs", "skyward-r",
  "toro-sv", "scalpel-r", "chrono-12", "colt-gt",
]);

const tuning = Object.freeze({
  acceleration: 245, reverseAcceleration: 150, braking: 360,
  maxForwardSpeed: 350, maxReverseSpeed: 120, longitudinalDrag: 0.72,
  rollingResistance: 10, lateralGrip: 7.5, turnRate: 3.15,
  steerResponse: 11, yawResponse: 14, fullSteerSpeed: 62,
  highSpeedSteerScale: 650,
});
const collision = Object.freeze({
  sweepStep: 1.5, rotationRadius: 22, restitution: 0.3,
  tangentialRetention: 0.86, separation: 0.75,
  normalProbeRadii: [2, 4, 6, 9, 12], normalProbeDirections: 16,
  yawKick: 0.0045, maxImpactYaw: 1.8,
});
const footprint = Object.freeze({ halfLength: 16, halfWidth: 9 });

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapAngle = (angle) => ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
const shortestAngleDelta = (from, to) => {
  const wrapped = wrapAngle(to - from);
  return wrapped > Math.PI ? wrapped - Math.PI * 2 : wrapped;
};
const dot = (a, b) => a.x * b.x + a.y * b.y;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const forward = (angle) => ({ x: Math.sin(angle), y: -Math.cos(angle) });
const right = (angle) => ({ x: Math.cos(angle), y: Math.sin(angle) });
const normalize = (v, fallback = { x: 0, y: 0 }) => {
  const length = Math.hypot(v.x, v.y);
  return length < 1e-8 ? { ...fallback } : { x: v.x / length, y: v.y / length };
};

export function createCircuitVehicle(spawn = {}) {
  const angle = spawn.angle ?? Math.PI / 2;
  return {
    x: spawn.x ?? 615, y: spawn.y ?? 850, angle,
    velocityX: 0, velocityY: 0, angularVelocity: 0, steerAmount: 0,
  };
}

export function stepCircuitVehicle(vehicle, input, dt = CIRCUIT_FIXED_STEP) {
  const safeDt = clamp(dt, 0, 0.05);
  const brake = clamp(Number(input?.brake) || 0, 0, 1);
  const throttle = brake > 0 ? -brake : clamp(Number(input?.throttle) || 0, -1, 1);
  const targetSteer = clamp(Number(input?.steer) || 0, -1, 1);
  const steerAmount = vehicle.steerAmount
    + (targetSteer - vehicle.steerAmount) * (1 - Math.exp(-tuning.steerResponse * safeDt));
  const f0 = forward(vehicle.angle);
  const forwardSpeed = dot({ x: vehicle.velocityX, y: vehicle.velocityY }, f0);
  const speedRatio = clamp(Math.abs(forwardSpeed) / tuning.fullSteerSpeed, 0, 1);
  const targetYaw = steerAmount * tuning.turnRate * speedRatio
    / (1 + Math.abs(forwardSpeed) / tuning.highSpeedSteerScale) * Math.sign(forwardSpeed);
  const angularVelocity = vehicle.angularVelocity
    + (targetYaw - vehicle.angularVelocity) * (1 - Math.exp(-tuning.yawResponse * safeDt));
  const angle = wrapAngle(vehicle.angle + angularVelocity * safeDt);
  const f = forward(angle);
  const r = right(angle);
  let longitudinal = dot({ x: vehicle.velocityX, y: vehicle.velocityY }, f);
  let lateral = dot({ x: vehicle.velocityX, y: vehicle.velocityY }, r);
  if (throttle > 0) longitudinal += (longitudinal < -4 ? tuning.braking : tuning.acceleration) * throttle * safeDt;
  else if (throttle < 0) longitudinal += (longitudinal > 4 ? tuning.braking : tuning.reverseAcceleration) * throttle * safeDt;
  else {
    const amount = (tuning.rollingResistance + Math.abs(longitudinal) * tuning.longitudinalDrag) * safeDt;
    longitudinal = longitudinal < 0 ? Math.min(longitudinal + amount, 0) : Math.max(longitudinal - amount, 0);
  }
  longitudinal = clamp(longitudinal, -tuning.maxReverseSpeed, tuning.maxForwardSpeed);
  lateral *= Math.exp(-tuning.lateralGrip * safeDt);
  const velocityX = f.x * longitudinal + r.x * lateral;
  const velocityY = f.y * longitudinal + r.y * lateral;
  return { ...vehicle, angle, angularVelocity, steerAmount, velocityX, velocityY,
    x: vehicle.x + velocityX * safeDt, y: vehicle.y + velocityY * safeDt };
}

const projectionRadius = (vehicle, axis) => (
  Math.abs(dot(right(vehicle.angle), axis)) * footprint.halfWidth
  + Math.abs(dot(forward(vehicle.angle), axis)) * footprint.halfLength
);

function vehicleContact(player, other) {
  const delta = { x: other.x - player.x, y: other.y - player.y };
  const axes = [right(player.angle), forward(player.angle), right(other.angle), forward(other.angle)];
  let overlap = Infinity;
  let normal = null;
  for (const axis of axes) {
    const amount = projectionRadius(player, axis) + projectionRadius(other, axis) - Math.abs(dot(delta, axis));
    if (amount <= 0) return { player, other };
    if (amount < overlap) {
      overlap = amount;
      normal = dot(delta, axis) >= 0 ? axis : { x: -axis.x, y: -axis.y };
    }
  }
  const separation = (overlap + 0.5) / 2;
  const relative = { x: other.velocityX - player.velocityX, y: other.velocityY - player.velocityY };
  const impact = Math.max(0, -dot(relative, normal));
  const impulse = impact * 1.34 / 2;
  return {
    player: { ...player, x: player.x - normal.x * separation, y: player.y - normal.y * separation,
      velocityX: player.velocityX - normal.x * impulse, velocityY: player.velocityY - normal.y * impulse,
      angularVelocity: clamp(player.angularVelocity - cross(forward(player.angle), normal) * impact * 0.0035, -1.8, 1.8) },
    other: { ...other, x: other.x + normal.x * separation, y: other.y + normal.y * separation,
      velocityX: other.velocityX + normal.x * impulse, velocityY: other.velocityY + normal.y * impulse,
      angularVelocity: clamp(other.angularVelocity + cross(forward(other.angle), normal) * impact * 0.0035, -1.8, 1.8) },
  };
}

function resolveTrack(previous, candidate, isDriveable) {
  const angleDelta = shortestAngleDelta(previous.angle, candidate.angle);
  const distance = Math.hypot(candidate.x - previous.x, candidate.y - previous.y);
  const steps = Math.max(1, Math.ceil(Math.max(distance, Math.abs(angleDelta) * collision.rotationRadius) / collision.sweepStep));
  let lastSafe = previous;
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const pose = { ...candidate, x: previous.x + (candidate.x - previous.x) * progress,
      y: previous.y + (candidate.y - previous.y) * progress,
      angle: wrapAngle(previous.angle + angleDelta * progress) };
    if (isDriveable(pose)) { lastSafe = pose; continue; }
    let nx = 0;
    let ny = 0;
    for (const radius of collision.normalProbeRadii) {
      for (let index = 0; index < collision.normalProbeDirections; index += 1) {
        const angle = index / collision.normalProbeDirections * Math.PI * 2;
        const direction = { x: Math.cos(angle), y: Math.sin(angle) };
        if (isDriveable({ ...pose, x: pose.x + direction.x * radius, y: pose.y + direction.y * radius })) {
          const weight = 1 + radius / 12;
          nx += direction.x * weight; ny += direction.y * weight;
        }
      }
    }
    const normal = normalize({ x: nx, y: ny }, normalize({ x: previous.x - pose.x, y: previous.y - pose.y }, { x: 0, y: -1 }));
    const normalVelocity = dot({ x: candidate.velocityX, y: candidate.velocityY }, normal);
    const impact = Math.max(0, -normalVelocity);
    const tangent = { x: candidate.velocityX - normal.x * normalVelocity,
      y: candidate.velocityY - normal.y * normalVelocity };
    return { ...lastSafe,
      velocityX: tangent.x * collision.tangentialRetention + normal.x * impact * collision.restitution,
      velocityY: tangent.y * collision.tangentialRetention + normal.y * impact * collision.restitution,
      angularVelocity: clamp(candidate.angularVelocity + cross(forward(lastSafe.angle), normal) * impact * collision.yawKick,
        -collision.maxImpactYaw, collision.maxImpactYaw), steerAmount: candidate.steerAmount };
  }
  return candidate;
}

function crossesCircle(previous, current, checkpoint) {
  const dx = current.x - previous.x;
  const dy = current.y - previous.y;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared > 0
    ? clamp(((checkpoint.x - previous.x) * dx + (checkpoint.y - previous.y) * dy) / lengthSquared, 0, 1) : 0;
  return Math.hypot(previous.x + dx * projection - checkpoint.x,
    previous.y + dy * projection - checkpoint.y) <= checkpoint.radius;
}

export function createCircuitRace({ players, laps = 3, timeoutSeconds = 300, track = OLD_TOWN_SHRINE_TRACK } = {}) {
  if (!Array.isArray(players) || players.length !== 2) throw new Error("Circuit Race requires two players");
  return {
    runtime: "circuit", trackId: track.id, status: "racing", tick: 0, elapsed: 0,
    rules: { laps: clamp(Math.trunc(laps), 1, 5), timeoutSeconds }, finishOrder: [],
    participants: players.map((player, index) => ({
      playerId: player.playerId, modelId: player.modelId, livery: player.livery ?? null,
      vehicle: createCircuitVehicle(track.spawns[index]),
      input: { throttle: 0, brake: 0, steer: 0, shift: 0 },
      nextCheckpoint: 1, lap: 0, finishedAt: null, place: null,
    })),
  };
}

export function applyCircuitInput(state, playerId, input = {}) {
  return { ...state, participants: state.participants.map((participant) => participant.playerId === playerId
    ? { ...participant, input: { throttle: clamp(Number(input.throttle) || 0, -1, 1),
      brake: clamp(Number(input.brake) || 0, 0, 1), steer: clamp(Number(input.steer) || 0, -1, 1),
      shift: Math.sign(Number(input.shift) || 0) } }
    : participant) };
}

export function stepCircuitRace(state, isDriveable = () => true, track = OLD_TOWN_SHRINE_TRACK) {
  if (state.status === "finished") return state;
  const previous = state.participants.map((participant) => participant.vehicle);
  let participants = state.participants.map((participant) => participant.finishedAt === null
    ? { ...participant, vehicle: resolveTrack(participant.vehicle,
      stepCircuitVehicle(participant.vehicle, participant.input), isDriveable) }
    : participant);
  const contact = vehicleContact(participants[0].vehicle, participants[1].vehicle);
  participants = [{ ...participants[0], vehicle: isDriveable(contact.player) ? contact.player : participants[0].vehicle },
    { ...participants[1], vehicle: isDriveable(contact.other) ? contact.other : participants[1].vehicle }];
  const elapsed = state.elapsed + CIRCUIT_FIXED_STEP;
  const finishOrder = [...state.finishOrder];
  participants = participants.map((participant, index) => {
    if (participant.finishedAt !== null) return participant;
    const checkpoint = track.checkpoints[participant.nextCheckpoint];
    if (!crossesCircle(previous[index], participant.vehicle, checkpoint)) return participant;
    const completed = participant.nextCheckpoint;
    const nextCheckpoint = (completed + 1) % track.checkpoints.length;
    if (completed !== 0) return { ...participant, nextCheckpoint };
    const lap = participant.lap + 1;
    if (lap < state.rules.laps) return { ...participant, nextCheckpoint, lap };
    const place = finishOrder.length + 1;
    finishOrder.push(participant.playerId);
    return { ...participant, nextCheckpoint, lap, place, finishedAt: elapsed };
  });
  const finished = participants.every((participant) => participant.finishedAt !== null)
    || elapsed >= state.rules.timeoutSeconds;
  return { ...state, tick: state.tick + 1, elapsed, participants, finishOrder,
    status: finished ? "finished" : "racing" };
}

export function circuitSnapshot(state) {
  return {
    runtime: state.runtime, trackId: state.trackId,
    tick: state.tick, elapsed: state.elapsed, status: state.status,
    finishOrder: [...state.finishOrder],
    participants: state.participants.map(({ playerId, vehicle, input, nextCheckpoint, lap, finishedAt, place }) => ({
      playerId, vehicle: { ...vehicle }, input: { ...input }, nextCheckpoint, lap, finishedAt, place,
    })),
  };
}
