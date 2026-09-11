// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/circuit/cpu-driver.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

import { clamp, dot, normalize } from "./math.mjs";
import { forwardVector, getSpeed, rightVector } from "./vehicle.mjs";

export function createCpuDriver(racingLine, targetIndex = 1, difficultyId = "normal") {
  return { racingLine, targetIndex: targetIndex % racingLine.length, difficultyId };
}

export function updateCpuDriver(driver, vehicle, options = {}) {
  const waypointRadius = options.waypointRadius ?? 58;
  let targetIndex = driver.targetIndex;
  for (let checked = 0; checked < driver.racingLine.length; checked += 1) {
    const target = driver.racingLine[targetIndex];
    if (Math.hypot(target.x - vehicle.x, target.y - vehicle.y) >= waypointRadius) break;
    targetIndex = (targetIndex + 1) % driver.racingLine.length;
  }
  const target = driver.racingLine[targetIndex];
  const direction = normalize({ x: target.x - vehicle.x, y: target.y - vehicle.y });
  const alignment = dot(forwardVector(vehicle.angle), direction);
  const steer = clamp(dot(rightVector(vehicle.angle), direction) / 0.48, -1, 1);
  const speed = getSpeed(vehicle);
  const cornerSpeed = options.cornerSpeed ?? 225;
  const cruiseSpeed = options.cruiseSpeed ?? 270;
  const sharpSteerThreshold = options.sharpSteerThreshold ?? 0.72;
  let throttle = 1;
  if (alignment < 0.2) throttle = -0.55;
  else if (Math.abs(steer) > sharpSteerThreshold && speed > cornerSpeed) throttle = -0.25;
  else if (speed > cruiseSpeed) throttle = 0;
  return { driver: { ...driver, targetIndex }, input: { throttle, steer } };
}
