// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/circuit/difficulty.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

import { CPU_VEHICLE_TUNING } from "./config.mjs";

/**
 * Authored CPU profiles shared by free-play setup and campaign missions.
 *
 * Difficulty changes the opponent's car control, never the player's vehicle.
 * Each rung is deterministic so a mission remains the same race on every retry.
 */
export const CIRCUIT_DIFFICULTIES = Object.freeze([
  Object.freeze({
    id: "easy",
    label: "EASY",
    blurb: "Earlier braking, gentler acceleration, and a lower top speed.",
    driver: Object.freeze({ cornerSpeed: 190, cruiseSpeed: 235, sharpSteerThreshold: 0.62 }),
    vehicle: Object.freeze({ acceleration: 180, braking: 300, maxForwardSpeed: 240, turnRate: 2.9 }),
  }),
  Object.freeze({
    id: "normal",
    label: "NORMAL",
    blurb: "A balanced club racer with consistent pace.",
    driver: Object.freeze({ cornerSpeed: 225, cruiseSpeed: 270, sharpSteerThreshold: 0.72 }),
    vehicle: Object.freeze({}),
  }),
  Object.freeze({
    id: "hard",
    label: "HARD",
    blurb: "Later braking, stronger acceleration, and more speed through corners.",
    driver: Object.freeze({ cornerSpeed: 255, cruiseSpeed: 315, sharpSteerThreshold: 0.82 }),
    vehicle: Object.freeze({ acceleration: 245, braking: 360, maxForwardSpeed: 325, turnRate: 3.15 }),
  }),
]);

export const DEFAULT_CIRCUIT_DIFFICULTY_ID = "normal";

export function circuitDifficultyById(id) {
  return CIRCUIT_DIFFICULTIES.find((entry) => entry.id === id)
    ?? CIRCUIT_DIFFICULTIES.find((entry) => entry.id === DEFAULT_CIRCUIT_DIFFICULTY_ID);
}

export function cpuVehicleTuningFor(id) {
  return { ...CPU_VEHICLE_TUNING, ...circuitDifficultyById(id).vehicle };
}
