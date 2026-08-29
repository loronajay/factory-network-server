// Where a HORSE player may hang the wall hoop, and how it may move once it is
// there. The rim's sibling of `sim/bin-placement.js`, and much the smaller of
// the two for one reason: A HOOP HAS NO DEPTH CHOICE.
//
// The backboard is bolted to the wall at `BOARD_Z` and the rim hangs off it at
// `RIM_CENTER_Z`, in every mode and every mode of play. So a placement here is
// two numbers where a bin's is three — how far along the wall, and how high —
// and both of them are SCREEN-SPACE, because the hoop's motion catalog is
// screen-space for the same reason. The rim sits at one fixed depth forever, so
// "left" means left on the canvas and a placement expressed any other way would
// have to be converted back before it could be added to a sweep. A bin's
// placement is in world units precisely because its depth IS the choice.
//
// THE VOLUME IS THE CABINET'S OWN TRAVEL, MINUS THE SWEEP. `HOOP_TRAVEL_BOUNDS`
// is the screen box every shipped mode's rim centre already stays inside — the
// portrait crop horizontally, and the band the classic run has always ridden
// vertically. Adopting it whole rather than inventing a wider one is what makes
// a HORSE hoop shot a shot the classic cabinet has already proved makeable, at a
// height it is already calibrated for; nothing here needs a new number and no
// existing one moves. A motion's measured envelope is then subtracted from it,
// exactly as `clampPlacement` subtracts a bin motion's — so choosing Left / Right
// while parked at the end of the wall steps the hoop in far enough for its whole
// run to fit, rather than letting half the sweep leave the screen.
//
// A CONSEQUENCE WORTH STATING PLAINLY: the busier the motion, the less room
// there is to hang it. Still has the whole box; Up / Down has four pixels of
// height and the width of the room. That is not timidity, it is the same
// arithmetic the bin lives under — the box is the cabinet's own travel, and a
// mode that already fills it has nowhere left to be moved to.
//
// The reticle's reach does not need restating here the way it does for a bin.
// `AIM_MIN_X..AIM_MAX_X` is 292..668 and the crop stops at 588, so the band a
// pull can swing across already contains every placement this file will allow —
// the "you may only place a target you could shoot at" rule is satisfied by
// construction rather than by a second clamp. `tests/horse.test.js` pins that,
// because the day the crop or the aim gain moves is the day it stops being free.
//
// Pure. No DOM, no storage, no rendering.

import { AIM_MAX_X, AIM_MIN_X, HOOP_BASE_RIM_Y, HOOP_BASE_X } from "./constants.js";
import { DEFAULT_HOOP_MODE, HOOP_TRAVEL_BOUNDS, hoopAt, hoopModeById } from "./hoop.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * The screen box a placed rim centre must stay inside, sweep included.
 *
 * It IS `HOOP_TRAVEL_BOUNDS` — imported and re-published under this name rather
 * than copied, so there is one statement of the box and a change to the portrait
 * crop moves the placement volume with it.
 */
export const HOOP_PLACEMENT_BOUNDS = HOOP_TRAVEL_BOUNDS;

/**
 * A mode's screen-space reach, sampled off its own path.
 *
 * Measured rather than declared, for the reason `motionEnvelope` is: the
 * amplitudes inside a path are not the reach of the path. `circle` is authored
 * as `(cos - 1)`, so it starts where the hoop was hung and travels TWICE its
 * amplitude, entirely to one side — a hand-written +/-94 would be wrong in both
 * directions at once. The envelope that comes out is asymmetric, which is also
 * strictly kinder: a circle hung on the right is only limited on its left.
 *
 * Cached, because the paths are pure — an envelope is a property of the catalog
 * rather than of a placement, and the clamp below runs on every drag event.
 */
const ENVELOPES = new Map();

export function hoopMotionEnvelope(modeId) {
  const mode = hoopModeById(modeId);
  const cached = ENVELOPES.get(mode.id);
  if (cached) return cached;

  const box = { minDx: 0, maxDx: 0, minDy: 0, maxDy: 0 };
  const steps = 4096;
  const period = Number.isFinite(mode.period) && mode.period > 0 ? mode.period : 1;
  for (let i = 0; i <= steps; i++) {
    const { dx, dy } = mode.path((i / steps) * period);
    box.minDx = Math.min(box.minDx, dx); box.maxDx = Math.max(box.maxDx, dx);
    box.minDy = Math.min(box.minDy, dy); box.maxDy = Math.max(box.maxDy, dy);
  }
  const frozen = Object.freeze(box);
  ENVELOPES.set(mode.id, frozen);
  return frozen;
}

/**
 * The band a hoop on this motion may be hung in.
 *
 * `max` is floored at `min` rather than allowed to invert: a mode whose sweep
 * were wider than the box would have exactly one legal base and no legal band,
 * and a clamp against an inverted range teleports rather than pins.
 */
export function hoopPlacementBoundsFor(motionId = DEFAULT_HOOP_MODE) {
  const envelope = hoopMotionEnvelope(motionId);
  const minCx = HOOP_PLACEMENT_BOUNDS.minX - envelope.minDx;
  const minRimY = HOOP_PLACEMENT_BOUNDS.minY - envelope.minDy;
  return {
    minCx,
    maxCx: Math.max(minCx, HOOP_PLACEMENT_BOUNDS.maxX - envelope.maxDx),
    minRimY,
    maxRimY: Math.max(minRimY, HOOP_PLACEMENT_BOUNDS.maxY - envelope.maxDy),
  };
}

/** Where the hoop hangs before anyone has moved it: the cabinet's own peg. */
export function defaultHoopPlacement() {
  return { cx: HOOP_BASE_X, rimY: HOOP_BASE_RIM_Y };
}

export function clampHoopPlacement(placement = {}, motionId = DEFAULT_HOOP_MODE) {
  const bounds = hoopPlacementBoundsFor(motionId);
  const fallback = defaultHoopPlacement();
  return {
    cx: clamp(Number.isFinite(placement.cx) ? placement.cx : fallback.cx, bounds.minCx, bounds.maxCx),
    rimY: clamp(Number.isFinite(placement.rimY) ? placement.rimY : fallback.rimY, bounds.minRimY, bounds.maxRimY),
  };
}

/**
 * A placement expressed as fractions of the legal band.
 *
 * `lateral` runs -1..1 out from the middle of the band and `height` 0..1 up it.
 * The seam the CPU hangs a hoop through, so `sim/horse.js` can decide how bold a
 * target to set without owning any geometry — the same contract
 * `placementFromFractions` keeps for the bin.
 */
export function hoopPlacementFromFractions({ lateral = 0, height = 0.5 } = {}, motionId = DEFAULT_HOOP_MODE) {
  const bounds = hoopPlacementBoundsFor(motionId);
  const middle = (bounds.minCx + bounds.maxCx) / 2;
  const halfWidth = (bounds.maxCx - bounds.minCx) / 2;
  return clampHoopPlacement({
    cx: middle + clamp(lateral, -1, 1) * halfWidth,
    rimY: bounds.minRimY + clamp(height, 0, 1) * (bounds.maxRimY - bounds.minRimY),
  }, motionId);
}

/** A complete, validated hoop setup: where the assembly hangs and what it does. */
export function normalizeHoopSetup(value = {}) {
  const motionId = hoopModeById(value.motionId).id;
  return { ...clampHoopPlacement(value.placement || value, motionId), motionId };
}

/**
 * The hoop as the physics and the renderer see it, at a moment in the turn.
 *
 * A pure function of elapsed seconds, exactly like `hoopAt` and `placedBinAt`:
 * it reads no clock, so the same setup replayed tick-for-tick puts the rim in
 * exactly the same place. That is what lets a matching player face the shot the
 * setter actually faced — both turns start this clock at zero.
 */
export function placedHoopAt(setup, elapsedSeconds = 0) {
  const rest = normalizeHoopSetup(setup);
  return hoopAt(rest.motionId, elapsedSeconds, rest);
}

/**
 * Is every placement this file allows inside the reticle's own reach?
 *
 * Exported so the test can ask rather than re-derive the answer, and phrased as
 * a question because it is one: it is true today by construction, and nothing
 * guarantees it except these two numbers staying where they are.
 */
export function placementIsWithinAimReach() {
  return HOOP_PLACEMENT_BOUNDS.minX >= AIM_MIN_X && HOOP_PLACEMENT_BOUNDS.maxX <= AIM_MAX_X;
}
