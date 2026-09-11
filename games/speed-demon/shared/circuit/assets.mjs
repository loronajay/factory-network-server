// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/circuit/assets.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

// Circuit car asset catalog.
//
// Every canonical garage model has its own directional atlas. Unknown ids
// remain unavailable rather than silently borrowing a different car's body.

import { CIRCUIT_MODEL_DEFINITIONS } from "./model-definitions.mjs";

export const CIRCUIT_FRAME_SIZE = 64;
export const CIRCUIT_ATLAS_VERSION = "circuit-full-roster-20260910-1";

export const CIRCUIT_DIRECTIONS = Object.freeze([
  "north",
  "north-east",
  "east",
  "south-east",
  "south",
  "south-west",
  "west",
  "north-west",
]);

// The compiler manifest and physical atlas columns use the same nose headings.
export const CIRCUIT_FRAME_HEADINGS = CIRCUIT_DIRECTIONS;

/** The screen-space angle of a canonical atlas frame, clockwise from north. */
export function circuitFrameAngle(frameIndex) {
  const frameCount = CIRCUIT_FRAME_HEADINGS.length;
  const normalized = ((Math.trunc(frameIndex) % frameCount) + frameCount) % frameCount;
  return normalized * Math.PI / 4;
}

// The generated masters do not share one silhouette mass. These measured
// factors normalize their mean visible area, so choosing a slim body does not
// make the player's car look smaller than the fixed CPU model in a race.
export const CIRCUIT_MODELS = Object.freeze(CIRCUIT_MODEL_DEFINITIONS.map(
  ([modelId, label, archetype, renderScale]) => Object.freeze({
    modelId,
    label,
    archetype,
    renderScale,
    spritesheet: `${modelId}/spritesheet-clockwise-from-north.png`,
    manifest: `${modelId}/spritesheet.json`,
    src: `assets/circuit-cars/${modelId}/spritesheet-clockwise-from-north.png?v=${CIRCUIT_ATLAS_VERSION}`,
    footprint: Object.freeze({ halfLength: 16, halfWidth: 9 }),
  }),
));

export function circuitModelById(modelId) {
  return CIRCUIT_MODELS.find((model) => model.modelId === modelId) ?? null;
}

export function hasCircuitAtlas(modelId) {
  return circuitModelById(modelId) !== null;
}
