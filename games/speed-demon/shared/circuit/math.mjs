// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/circuit/math.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

export const TAU = Math.PI * 2;

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function approach(value, target, amount) {
  if (value < target) return Math.min(value + amount, target);
  if (value > target) return Math.max(value - amount, target);
  return value;
}

export const wrapAngle = (angle) => ((angle % TAU) + TAU) % TAU;

export function shortestAngleDelta(from, to) {
  const wrapped = wrapAngle(to - from);
  return wrapped > Math.PI ? wrapped - TAU : wrapped;
}

export const exponentialBlend = (rate, dt) => 1 - Math.exp(-rate * dt);
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const magnitude = (vector) => Math.hypot(vector.x, vector.y);

export function normalize(vector, fallback = { x: 0, y: 0 }) {
  const length = magnitude(vector);
  return length < 1e-8 ? { ...fallback } : { x: vector.x / length, y: vector.y / length };
}
