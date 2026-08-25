import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { CIRCUIT_TRACK_IDS } from "./circuit-tracks.mjs";

// The shipped mask is an 8-bit, non-interlaced grayscale PNG. Decode it here
// with built-ins so the authoritative server uses the exact same road pixels as
// the cabinet without adding a server dependency.
export function loadCircuitRoadMask(trackId = "old-town-shrine-loop") {
  const known = new Set(CIRCUIT_TRACK_IDS);
  if (!known.has(trackId)) throw new Error(`Unknown circuit road mask '${trackId}'`);
  const url = new URL(`../assets/${trackId}-road-mask.png`, import.meta.url);
  const png = readFileSync(url);
  if (png.readUInt32BE(12) !== 0x49484452) throw new Error("Invalid circuit road mask PNG");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (png[24] !== 8 || png[25] !== 0 || png[28] !== 0) throw new Error("Unsupported circuit road mask PNG");
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  const source = inflateSync(Buffer.concat(chunks));
  const pixels = new Uint8Array(width * height);
  let cursor = 0;
  let sourceOffset = 0;
  let prior = new Uint8Array(width);
  for (let y = 0; y < height; y += 1) {
    const filter = source[sourceOffset++];
    const row = new Uint8Array(width);
    for (let x = 0; x < width; x += 1) {
      const raw = source[sourceOffset++];
      const left = x > 0 ? row[x - 1] : 0;
      const up = prior[x];
      const upperLeft = x > 0 ? prior[x - 1] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up
        : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      row[x] = (raw + predictor) & 255;
      pixels[cursor++] = row[x];
    }
    prior = row;
  }
  const containsPoint = (x, y) => {
    const px = Math.round(x);
    const py = Math.round(y);
    return px >= 0 && px < width && py >= 0 && py < height && pixels[py * width + px] > 127;
  };
  return {
    width, height, pixels,
    containsVehicle(vehicle) {
      const forward = { x: Math.sin(vehicle.angle), y: -Math.cos(vehicle.angle) };
      const right = { x: Math.cos(vehicle.angle), y: Math.sin(vehicle.angle) };
      for (const along of [0, 16, -16]) for (const across of [0, 9, -9]) {
        if (!containsPoint(vehicle.x + forward.x * along + right.x * across,
          vehicle.y + forward.y * along + right.y * across)) return false;
      }
      return true;
    },
  };
}

function paeth(left, up, upperLeft) {
  const p = left + up - upperLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upperLeft);
  return pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft;
}
