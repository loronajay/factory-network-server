// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/circuit/vehicle.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

import { VEHICLE_TUNING } from "./config.mjs";
import { approach, clamp, dot, exponentialBlend, magnitude, wrapAngle } from "./math.mjs";

export const forwardVector = (angle) => ({ x: Math.sin(angle), y: -Math.cos(angle) });
export const rightVector = (angle) => ({ x: Math.cos(angle), y: Math.sin(angle) });

export function createVehicle(overrides = {}) {
  const angle = overrides.angle ?? Math.PI / 2;
  const forward = forwardVector(angle);
  const speed = overrides.speed ?? 0;
  return {
    x: overrides.x ?? 615,
    y: overrides.y ?? 850,
    angle,
    velocityX: overrides.velocityX ?? forward.x * speed,
    velocityY: overrides.velocityY ?? forward.y * speed,
    angularVelocity: overrides.angularVelocity ?? 0,
    steerAmount: overrides.steerAmount ?? 0,
  };
}

export const getSpeed = (vehicle) => magnitude({ x: vehicle.velocityX, y: vehicle.velocityY });
export const getForwardSpeed = (vehicle) => dot(
  { x: vehicle.velocityX, y: vehicle.velocityY },
  forwardVector(vehicle.angle),
);

export function directionIndex(angle) {
  return Math.round(wrapAngle(angle) / (Math.PI / 4)) % 8;
}

export function stepVehicle(vehicle, input, dt, tuning = VEHICLE_TUNING) {
  const safeDt = clamp(dt, 0, 0.05);
  const throttle = clamp(input?.throttle || 0, -1, 1);
  const targetSteer = clamp(input?.steer || 0, -1, 1);
  const steerBlend = exponentialBlend(tuning.steerResponse, safeDt);
  const steerAmount = vehicle.steerAmount + (targetSteer - vehicle.steerAmount) * steerBlend;
  const currentForwardSpeed = getForwardSpeed(vehicle);
  const speedRatio = clamp(Math.abs(currentForwardSpeed) / tuning.fullSteerSpeed, 0, 1);
  const highSpeedStability = 1 / (1 + Math.abs(currentForwardSpeed) / tuning.highSpeedSteerScale);
  const targetYaw = steerAmount * tuning.turnRate * speedRatio * highSpeedStability
    * Math.sign(currentForwardSpeed);
  const yawBlend = exponentialBlend(tuning.yawResponse, safeDt);
  const angularVelocity = vehicle.angularVelocity + (targetYaw - vehicle.angularVelocity) * yawBlend;
  const angle = wrapAngle(vehicle.angle + angularVelocity * safeDt);
  const forward = forwardVector(angle);
  const right = rightVector(angle);
  let longitudinalSpeed = dot({ x: vehicle.velocityX, y: vehicle.velocityY }, forward);
  let lateralSpeed = dot({ x: vehicle.velocityX, y: vehicle.velocityY }, right);

  if (throttle > 0) {
    longitudinalSpeed += (longitudinalSpeed < -4 ? tuning.braking : tuning.acceleration)
      * throttle * safeDt;
  } else if (throttle < 0) {
    longitudinalSpeed += (longitudinalSpeed > 4 ? tuning.braking : tuning.reverseAcceleration)
      * throttle * safeDt;
  } else {
    longitudinalSpeed = approach(
      longitudinalSpeed,
      0,
      (tuning.rollingResistance + Math.abs(longitudinalSpeed) * tuning.longitudinalDrag) * safeDt,
    );
  }

  longitudinalSpeed = clamp(longitudinalSpeed, -tuning.maxReverseSpeed, tuning.maxForwardSpeed);
  lateralSpeed *= Math.exp(-tuning.lateralGrip * safeDt);
  const velocityX = forward.x * longitudinalSpeed + right.x * lateralSpeed;
  const velocityY = forward.y * longitudinalSpeed + right.y * lateralSpeed;
  return {
    ...vehicle,
    angle,
    angularVelocity,
    steerAmount,
    velocityX,
    velocityY,
    x: vehicle.x + velocityX * safeDt,
    y: vehicle.y + velocityY * safeDt,
  };
}
