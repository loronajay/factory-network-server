// The shape of the table, derived once from `constants.js`.
//
// Pockets, cushion segments and jaw centres are computed here rather than typed
// into the physics and the renderer separately. That is the whole point of the
// file: in the demo the collider and the mesh builder each wrote out their own
// copy of the six pocket positions and the four gap widths, so a table tweak had
// to be made twice and a ball could pass through a rail the player could see.
//
// Pure. No THREE, no DOM.

import {
  CORNER_GAP,
  CORNER_POCKET_RADIUS,
  HALF_LENGTH,
  HALF_WIDTH,
  SIDE_GAP,
  SIDE_POCKET_RADIUS,
} from "./constants.js";

/**
 * @typedef {object} Pocket
 * @property {string} id     stable id, so a caller can name a pocket
 * @property {number} x
 * @property {number} z
 * @property {number} radius capture radius at the centre
 * @property {boolean} corner corners are wider and take balls at sharper angles
 */

/** The six pockets, corners first. Order is stable and the CPU relies on it. */
export const POCKETS = Object.freeze([
  Object.freeze({ id: "corner-hl", x: -HALF_LENGTH, z: -HALF_WIDTH, radius: CORNER_POCKET_RADIUS, corner: true }),
  Object.freeze({ id: "corner-hr", x: -HALF_LENGTH, z: HALF_WIDTH, radius: CORNER_POCKET_RADIUS, corner: true }),
  Object.freeze({ id: "corner-fl", x: HALF_LENGTH, z: -HALF_WIDTH, radius: CORNER_POCKET_RADIUS, corner: true }),
  Object.freeze({ id: "corner-fr", x: HALF_LENGTH, z: HALF_WIDTH, radius: CORNER_POCKET_RADIUS, corner: true }),
  Object.freeze({ id: "side-l", x: 0, z: -HALF_WIDTH, radius: SIDE_POCKET_RADIUS, corner: false }),
  Object.freeze({ id: "side-r", x: 0, z: HALF_WIDTH, radius: SIDE_POCKET_RADIUS, corner: false }),
]);

/**
 * The rounded pocket facings, as circles a ball can strike.
 *
 * Every pocket mouth is bounded by two of these. Without them a ball that just
 * misses a pocket bounces off a square invisible corner and leaves at an angle
 * no real table produces; with them it rattles the jaw the way it should. The
 * centres are exactly where the cushion segments end, which is why both come
 * from this file.
 */
export const JAWS = Object.freeze(
  [
    // Side pockets, on both long rails.
    ...[-1, 1].flatMap((side) => [
      { x: -SIDE_GAP, z: side * HALF_WIDTH },
      { x: SIDE_GAP, z: side * HALF_WIDTH },
    ]),
    // Corner pockets, approached along the long rails.
    ...[-1, 1].flatMap((side) => [
      { x: -HALF_LENGTH + CORNER_GAP, z: side * HALF_WIDTH },
      { x: HALF_LENGTH - CORNER_GAP, z: side * HALF_WIDTH },
    ]),
    // The same corners, approached along the short rails.
    ...[-1, 1].flatMap((side) => [
      { x: -HALF_LENGTH, z: side * (HALF_WIDTH - CORNER_GAP) },
      { x: HALF_LENGTH, z: side * (HALF_WIDTH - CORNER_GAP) },
    ]),
  ].map((jaw) => Object.freeze(jaw)),
);

/**
 * The cushion runs, as straight segments with an inward normal.
 *
 * Each long rail is two runs with the side pocket between them; each short rail
 * is one. `from`/`to` are along the rail, so the renderer can build a rubber box
 * of exactly the length the collider will bounce off.
 *
 * @typedef {object} Cushion
 * @property {"long"|"short"} rail
 * @property {number} side       -1 or 1, which of the pair
 * @property {number} from       start along the rail axis
 * @property {number} to         end along the rail axis
 * @property {number} nx         inward normal
 * @property {number} nz
 */
export const CUSHIONS = Object.freeze(
  [
    ...[-1, 1].flatMap((side) => [
      { rail: "long", side, from: -HALF_LENGTH + CORNER_GAP, to: -SIDE_GAP, nx: 0, nz: -side },
      { rail: "long", side, from: SIDE_GAP, to: HALF_LENGTH - CORNER_GAP, nx: 0, nz: -side },
    ]),
    ...[-1, 1].map((side) => ({
      rail: "short",
      side,
      from: -HALF_WIDTH + CORNER_GAP,
      to: HALF_WIDTH - CORNER_GAP,
      nx: -side,
      nz: 0,
    })),
  ].map((cushion) => Object.freeze(cushion)),
);

/** Resolve a pocket by id. Null rather than a throw, like every other lookup here. */
export function pocketById(id) {
  return POCKETS.find((pocket) => pocket.id === id) || null;
}

/**
 * Is a point inside the cushions, allowing for a ball of the given radius?
 *
 * Deliberately ignores the pocket mouths: this answers "is this on the cloth",
 * which is what placement and the aim guide want. Whether a ball has fallen in
 * is `pockets.js`, and it is a different question with a different answer at the
 * same coordinates.
 */
export function isOnCloth(x, z, radius = 0) {
  return Math.abs(x) <= HALF_LENGTH - radius && Math.abs(z) <= HALF_WIDTH - radius;
}
