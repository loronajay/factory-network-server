// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/circuit/road-mask.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

import { VEHICLE_FOOTPRINT } from "./config.mjs";
import { forwardVector, rightVector } from "./vehicle.mjs";

export function vehicleFootprintPoints(vehicle, footprint = VEHICLE_FOOTPRINT) {
  const forward = forwardVector(vehicle.angle);
  const right = rightVector(vehicle.angle);
  const points = [];
  for (const along of [0, footprint.halfLength, -footprint.halfLength]) {
    for (const across of [0, footprint.halfWidth, -footprint.halfWidth]) {
      points.push({
        x: vehicle.x + forward.x * along + right.x * across,
        y: vehicle.y + forward.y * along + right.y * across,
      });
    }
  }
  return points;
}

export function createRoadMask({ width, height, pixels }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || pixels.length < width * height) {
    throw new Error("Invalid circuit road mask");
  }
  const containsPoint = (x, y) => {
    const px = Math.round(x);
    const py = Math.round(y);
    return px >= 0 && px < width && py >= 0 && py < height && pixels[py * width + px] > 127;
  };
  return {
    width,
    height,
    pixels,
    containsPoint,
    containsVehicle(vehicle) {
      return vehicleFootprintPoints(vehicle).every((point) => containsPoint(point.x, point.y));
    },
  };
}

export function maskPixelsFromRgba(rgba) {
  const pixels = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = rgba[i * 4];
  return pixels;
}

export function roadMaskFromImage(image, world) {
  if (!image?.complete || image.naturalWidth <= 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = world.width;
  canvas.height = world.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, world.width, world.height);
  const rgba = context.getImageData(0, 0, world.width, world.height).data;
  return createRoadMask({ width: world.width, height: world.height, pixels: maskPixelsFromRgba(rgba) });
}
