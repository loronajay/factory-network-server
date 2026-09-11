// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/circuit/collision.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

import { COLLISION_TUNING } from "./config.mjs";
import { clamp, cross, dot, normalize, shortestAngleDelta, wrapAngle } from "./math.mjs";
import { forwardVector } from "./vehicle.mjs";

function interpolateVehicle(previous, candidate, progress, angleDelta) {
  return {
    ...candidate,
    x: previous.x + (candidate.x - previous.x) * progress,
    y: previous.y + (candidate.y - previous.y) * progress,
    angle: wrapAngle(previous.angle + angleDelta * progress),
  };
}

function estimateInwardNormal(blocked, previous, isDriveable, tuning) {
  let x = 0;
  let y = 0;
  for (const radius of tuning.normalProbeRadii) {
    for (let index = 0; index < tuning.normalProbeDirections; index += 1) {
      const angle = index / tuning.normalProbeDirections * Math.PI * 2;
      const direction = { x: Math.cos(angle), y: Math.sin(angle) };
      if (isDriveable({ ...blocked, x: blocked.x + direction.x * radius, y: blocked.y + direction.y * radius })) {
        const weight = 1 + radius / tuning.normalProbeRadii.at(-1);
        x += direction.x * weight;
        y += direction.y * weight;
      }
    }
  }
  const fallback = normalize({ x: previous.x - blocked.x, y: previous.y - blocked.y }, { x: 0, y: -1 });
  return normalize({ x, y }, fallback);
}

export function resolveTrackCollision(previous, candidate, isDriveable, tuning = COLLISION_TUNING) {
  const distance = Math.hypot(candidate.x - previous.x, candidate.y - previous.y);
  const angleDelta = shortestAngleDelta(previous.angle, candidate.angle);
  const steps = Math.max(1, Math.ceil(Math.max(
    distance,
    Math.abs(angleDelta) * tuning.rotationRadius,
  ) / tuning.sweepStep));
  let lastSafe = previous;

  for (let step = 1; step <= steps; step += 1) {
    const pose = interpolateVehicle(previous, candidate, step / steps, angleDelta);
    if (isDriveable(pose)) {
      lastSafe = pose;
      continue;
    }
    const normal = estimateInwardNormal(pose, previous, isDriveable, tuning);
    const velocity = { x: candidate.velocityX, y: candidate.velocityY };
    const normalVelocity = dot(velocity, normal);
    const impactSpeed = Math.max(0, -normalVelocity);
    const tangent = {
      x: velocity.x - normal.x * normalVelocity,
      y: velocity.y - normal.y * normalVelocity,
    };
    const velocityX = tangent.x * tuning.tangentialRetention
      + normal.x * impactSpeed * tuning.restitution;
    const velocityY = tangent.y * tuning.tangentialRetention
      + normal.y * impactSpeed * tuning.restitution;
    const yaw = cross(forwardVector(lastSafe.angle), normal) * impactSpeed * tuning.yawKick;
    const nudged = {
      ...lastSafe,
      x: lastSafe.x + normal.x * tuning.separation,
      y: lastSafe.y + normal.y * tuning.separation,
    };
    const settled = isDriveable(nudged) ? nudged : lastSafe;
    return {
      vehicle: {
        ...settled,
        velocityX,
        velocityY,
        angularVelocity: clamp(candidate.angularVelocity + yaw, -tuning.maxImpactYaw, tuning.maxImpactYaw),
        steerAmount: candidate.steerAmount,
      },
      impact: { normal, speed: impactSpeed, point: { x: pose.x, y: pose.y } },
    };
  }
  return { vehicle: candidate, impact: null };
}
