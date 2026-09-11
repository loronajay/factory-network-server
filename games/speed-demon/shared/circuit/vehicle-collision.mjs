// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/circuit/vehicle-collision.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

import { VEHICLE_FOOTPRINT } from "./config.mjs";
import { clamp, cross, dot } from "./math.mjs";
import { forwardVector, rightVector } from "./vehicle.mjs";

const CONTACT_TUNING = Object.freeze({
  restitution: 0.34,
  separationSlop: 0.5,
  yawKick: 0.0035,
  maxYaw: 1.8,
});

const projectionRadius = (vehicle, axis, footprint) => (
  Math.abs(dot(rightVector(vehicle.angle), axis)) * footprint.halfWidth
  + Math.abs(dot(forwardVector(vehicle.angle), axis)) * footprint.halfLength
);

export function resolveVehicleCollision(
  player,
  cpu,
  footprint = VEHICLE_FOOTPRINT,
  tuning = CONTACT_TUNING,
) {
  const delta = { x: cpu.x - player.x, y: cpu.y - player.y };
  const axes = [
    rightVector(player.angle), forwardVector(player.angle),
    rightVector(cpu.angle), forwardVector(cpu.angle),
  ];
  let minimumOverlap = Infinity;
  let normal = null;
  for (const axis of axes) {
    const overlap = projectionRadius(player, axis, footprint)
      + projectionRadius(cpu, axis, footprint)
      - Math.abs(dot(delta, axis));
    if (overlap <= 0) return { player, cpu, impact: null };
    if (overlap < minimumOverlap) {
      minimumOverlap = overlap;
      normal = dot(delta, axis) >= 0 ? axis : { x: -axis.x, y: -axis.y };
    }
  }

  const separation = (minimumOverlap + tuning.separationSlop) / 2;
  const relative = { x: cpu.velocityX - player.velocityX, y: cpu.velocityY - player.velocityY };
  const impactSpeed = Math.max(0, -dot(relative, normal));
  const impulse = impactSpeed * (1 + tuning.restitution) / 2;
  const playerYaw = cross(forwardVector(player.angle), normal) * impactSpeed * tuning.yawKick;
  const cpuYaw = cross(forwardVector(cpu.angle), normal) * impactSpeed * tuning.yawKick;
  return {
    player: {
      ...player,
      x: player.x - normal.x * separation,
      y: player.y - normal.y * separation,
      velocityX: player.velocityX - normal.x * impulse,
      velocityY: player.velocityY - normal.y * impulse,
      angularVelocity: clamp(player.angularVelocity - playerYaw, -tuning.maxYaw, tuning.maxYaw),
    },
    cpu: {
      ...cpu,
      x: cpu.x + normal.x * separation,
      y: cpu.y + normal.y * separation,
      velocityX: cpu.velocityX + normal.x * impulse,
      velocityY: cpu.velocityY + normal.y * impulse,
      angularVelocity: clamp(cpu.angularVelocity + cpuYaw, -tuning.maxYaw, tuning.maxYaw),
    },
    impact: { normal, overlap: minimumOverlap, speed: impactSpeed },
  };
}
