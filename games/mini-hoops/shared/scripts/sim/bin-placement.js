// Where a HORSE player may stand a bin, and how it may move once it is there.
//
// Floor Tic-Tac-Toe nails nine bins to a fixed grid. HORSE hands the grid to the
// player: one bin, placed anywhere the room allows, then given a motion. That is
// the whole of what this file owns — the legal volume, the clamp into it, and
// the motion catalog. It decides nothing about turns, letters or scoring.
//
// TWO THINGS ARE DELIBERATELY DIFFERENT FROM THE HOOP'S MOTION CATALOG.
//
// The hoop's modes are authored in SCREEN space, because the hoop sits at one
// fixed depth forever and "left" means left on the canvas. A placed bin does
// not: its depth is the player's choice and the whole point of the mode. A
// screen-space sweep of 100px is a much longer walk through the room at the back
// than at the front, so the same named motion would be a different shot
// depending on where the bin was standing. These are authored in WORLD units,
// and the projection is left to make a distant sweep look distant.
//
// And there is a motion the hoop cannot have at all: `inout`, straight down the
// room's depth axis. It exists here because depth is a free axis here.
//
// THE BOUNDS ARE DERIVED, NEVER TYPED. Depth comes off `BOARD_Z`, which is the
// back wall and is itself derived from the camera, so a deeper room widens the
// legal volume on its own with nothing here re-measured. That is the
// requirement: this mode has to work in whatever room it is handed.
//
// Height is the interesting one, and it does NOT come off the ceiling — see
// `maxMouthHeightAt`. The limit on how high a bin may be raised is the bin's own
// picture, not the room's roof.

import {
  AIM_MAX_X,
  AIM_MIN_X,
  BALL_RADIUS_WORLD,
  BOARD_Z,
  CANVAS_WIDTH,
  HORIZON_SCREEN_Y,
} from "./constants.js";
import {
  BIN_MOUTH_RADIUS,
  BIN_MOUTH_Y,
  BIN_PAINTED_MOUTH_ASPECT,
  BIN_RIM_TUBE_RADIUS,
  BIN_WALL_THICKNESS,
  createBin,
} from "./bin-physics.js";
import { projectPoint, ringEllipseAt, worldToScreenLength } from "./projection.js";

const TAU = Math.PI * 2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * The bin's own height: mouth rim down to the foot it stands on.
 *
 * Held at exactly the Tic-Tac-Toe board's `BIN_MOUTH_Y`, so a HORSE bin resting
 * on the floor is dimensionally the bin that mode's physics was tuned and tested
 * against. Raising a bin raises the whole drum; it never stretches it, because
 * the sprite is drawn at one uniform scale and stretching the collider would put
 * it straight back out of agreement with the picture.
 */
export const BIN_BODY_HEIGHT = BIN_MOUTH_Y;

/** How far the mouth's outer lip reaches from the bin's axis. */
const MOUTH_OUTER = BIN_MOUTH_RADIUS + BIN_RIM_TUBE_RADIUS;

/**
 * The legal volume, before any motion is subtracted from it.
 *
 * `minZ` is the front limit, and it is the same statement Tic-Tac-Toe's front
 * row makes: a bin has a real body and the held ball has a real radius, so a bin
 * any closer would start the shot with the ball already inside the drum's front
 * wall. `maxZ` keeps the far lip off the back wall.
 *
 * There is no `maxY` here, because the height limit is not a constant — see
 * `maxMouthHeightAt`. Nothing checks whether a placement is REACHABLE, and
 * nothing should: HORSE makes the setter shoot first, so an impossible bin costs
 * the player who placed it their own turn. The rules punish greed here far
 * better than a bounds check could.
 */
export const PLACEMENT_BOUNDS = Object.freeze({
  minZ: MOUTH_OUTER + BIN_WALL_THICKNESS + 2 * BALL_RADIUS_WORLD,
  maxZ: BOARD_Z - MOUTH_OUTER,
  minY: BIN_BODY_HEIGHT,
});

/**
 * The world height the camera's own eye line sits at — where a horizontal ring
 * draws as a flat line, and the hard ceiling on `maxMouthHeightAt`'s search.
 *
 * Depth-independent by construction: in a pinhole every point at eye height
 * projects onto the horizon, whatever its depth. Solved once, off the projection
 * itself, so a change to the camera carries it.
 */
export const EYE_LEVEL_Y = (() => {
  let lo = 0;
  let hi = 12;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (projectPoint({ x: 0, y: mid, z: 1 }).y > HORIZON_SCREEN_Y) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
})();

/**
 * How high this bin may be raised at a given depth, AND WHY IT IS NOT THE CEILING.
 *
 * The obvious limit is the roof, and it is the wrong one by a long way. The bin
 * is a photograph of a bin seen from slightly above: its painted opening is an
 * ellipse 0.231 as tall as it is wide, and that is a picture of a mouth being
 * looked DOWN into. Raise the bin toward eye level — 1.223 in this camera, and
 * the same at every depth, as a pinhole requires — and a real mouth there
 * projects flatter and flatter until at eye level it is a line; above it you
 * would be looking at the drum's underside, and the sprite would be painting an
 * open mouth on a bin whose opening faces away from you.
 *
 * So the ceiling is not the constraint. THE ART IS. This returns the highest
 * mouth whose honest projection is still at least as round as the one the sprite
 * paints, which is exactly the condition `solveBinMouthTilt` needs a solution to
 * exist — above this height there is no lean that lands the collider on the
 * picture, and the two would silently stop describing the same object.
 *
 * It falls with depth, because a bin further away is seen from a shallower angle
 * — about 0.97 at the front of the room and 0.87 at the back. Bisected against
 * the real projection rather than derived, for the same reason the tilt is: the
 * projection is not linear in height.
 *
 * `MOUTH_ASPECT_TOLERANCE` is the one deliberate slackening of that rule, and it
 * is why those numbers are not the 0.88/0.76 they used to be. Held at exactly
 * 1.0 the cap is the last height at which the collider lands on the painted
 * mouth EXACTLY, and it left a usable band of about 0.5 world units to place in,
 * which reads as a height slider that barely does anything. Below 1.0 the cap is
 * the last height at which the honest projection is still this share as round as
 * the paint — past the exact solution, `solveBinMouthTilt` returns a flat mouth
 * and the collider projects slightly FLATTER than the sprite draws.
 *
 * That direction is the safe one, and it is the reason a tolerance is acceptable
 * here at all: a collider narrower front-to-back than its own picture makes the
 * very top of the range a touch meaner than it looks, where the opposite would
 * let a ball drop through paint. It is bounded — at the cap the opening's
 * footprint is `MOUTH_ASPECT_TOLERANCE` of the painted one, and everywhere below
 * it the agreement is still exact. It is NOT a licence to keep climbing: raise
 * it toward eye level and the sprite is painting an open mouth on a bin whose
 * opening faces away from the camera, which no tolerance makes true.
 */
const MOUTH_ASPECT_TOLERANCE = 0.75;

export function maxMouthHeightAt(z) {
  const floor = BIN_PAINTED_MOUTH_ASPECT * MOUTH_ASPECT_TOLERANCE;
  const aspectAt = (y) => {
    const centre = projectPoint({ x: 0, y, z });
    const ring = ringEllipseAt(centre.x, centre.y, MOUTH_OUTER, z);
    return ring.radiusX > 0 ? ring.radiusY / ring.radiusX : 0;
  };
  if (aspectAt(BIN_BODY_HEIGHT) <= floor) return BIN_BODY_HEIGHT;

  let lo = BIN_BODY_HEIGHT;
  let hi = EYE_LEVEL_Y;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (aspectAt(mid) > floor) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}


/**
 * The horizontal band a bin's drawn mouth has to stay inside, in canvas pixels.
 *
 * Same kind of constraint as the hoop's `HOOP_TRAVEL_BOUNDS`, and stated for the
 * same reason: the canvas is drawn at a fixed 960 wide and CROPPED TO WIDTH on a
 * portrait phone, so a bin placed outside this band is simply off the screen on
 * the device most people will play on — and it looks perfect in the desktop
 * browser it was placed in. The band is that crop: a 760-tall court at a typical
 * phone aspect shows about 515 of the 960 columns, centred, which is 222..738.
 * Pulled in a little for margin.
 *
 * It is a SCREEN bound rather than a world one on purpose. A world unit is worth
 * far more pixels at the front of the room than at the back, so a fixed world
 * limit would waste most of the visible floor at depth — which is exactly the
 * part of the room this mode exists to open up.
 */
export const PLACEMENT_SCREEN_BOUNDS = Object.freeze({ minX: 240, maxX: CANVAS_WIDTH - 240 });

/**
 * The motion catalog.
 *
 * `path` returns a world-space offset from the placed position AND its exact
 * derivative, on the same contract the hoop modes are held to — the colliders
 * resolve the ball against a moving bin, so a velocity that disagrees with the
 * path is a lip that kicks the ball as though it were somewhere else.
 *
 * `period` is how long the path takes to come back to itself, and it is the only
 * thing about the sweep that is DECLARED. What the sweep costs in each axis —
 * its envelope — is measured off the path itself by `motionEnvelope`, and
 * `clampPlacement` insets the legal volume by that. Without the inset a player
 * could park a bin against the back wall, choose In / Out, and have it drive
 * through the plaster.
 *
 * Measuring rather than declaring is not tidiness. Two of these paths are offset
 * cosines — `(cos - 1)` — so that the orbit STARTS at the placed position rather
 * than a quarter-turn away from it, and that offset means they travel twice
 * their amplitude, entirely in one direction. Hand-written reaches said
 * otherwise for both, and a circle placed against the left edge of the room
 * swept a bin off the side of the reticle's reach. The envelope is asymmetric
 * for exactly that reason, which is also strictly kinder: a circle placed on the
 * right is only limited on its left.
 */
export const BIN_MOTIONS = Object.freeze([
  {
    id: "still",
    label: "Still",
    blurb: "The bin stands where you put it.",
    period: 1,
    path: () => ({ dx: 0, dy: 0, dz: 0, vx: 0, vy: 0, vz: 0 }),
  },
  {
    id: "sideways",
    label: "Left / Right",
    blurb: "It slides across the room. Lead it.",
    period: 3.6,
    path: (seconds) => {
      const omega = TAU / 3.6;
      const a = 0.34;
      const angle = seconds * omega;
      return {
        dx: Math.sin(angle) * a, dy: 0, dz: 0,
        vx: Math.cos(angle) * a * omega, vy: 0, vz: 0,
      };
    },
  },
  {
    id: "updown",
    label: "Up / Down",
    blurb: "It rides up and down. Time the arc.",
    period: 3.2,
    path: (seconds) => {
      const omega = TAU / 3.2;
      // The vertical amplitudes across this catalog are small next to the
      // horizontal ones, and that is the room talking rather than timidity: an
      // honestly-drawable bin lives in about 0.4 of world height (see
      // `maxMouthHeightAt`) against several times that much floor.
      const a = 0.15;
      const angle = seconds * omega;
      return {
        dx: 0, dy: Math.sin(angle) * a, dz: 0,
        vx: 0, vy: Math.cos(angle) * a * omega, vz: 0,
      };
    },
  },
  {
    id: "inout",
    label: "In / Out",
    blurb: "It runs down the room and back. Only the depth changes.",
    period: 4,
    path: (seconds) => {
      const omega = TAU / 4;
      const a = 0.2;
      const angle = seconds * omega;
      return {
        dx: 0, dy: 0, dz: Math.sin(angle) * a,
        vx: 0, vy: 0, vz: Math.cos(angle) * a * omega,
      };
    },
  },
  {
    id: "circle",
    label: "Circle",
    blurb: "It orbits in the air, across and up at once.",
    period: 4.2,
    path: (seconds) => {
      const omega = TAU / 4.2;
      const ax = 0.3;
      const ay = 0.12;
      const angle = seconds * omega;
      // Cosine on x, sine on y, so the orbit STARTS at the placed position
      // rather than a quarter turn away from it — the bin the player lined up
      // while placing is the bin that is there when the shot begins.
      return {
        dx: (Math.cos(angle) - 1) * ax, dy: Math.sin(angle) * ay, dz: 0,
        vx: -Math.sin(angle) * ax * omega, vy: Math.cos(angle) * ay * omega, vz: 0,
      };
    },
  },
  {
    id: "carousel",
    label: "Carousel",
    blurb: "A flat circle on the floor plan — across and away at once.",
    period: 4.6,
    path: (seconds) => {
      const omega = TAU / 4.6;
      const ax = 0.28;
      const az = 0.16;
      const angle = seconds * omega;
      return {
        dx: Math.sin(angle) * ax, dy: 0, dz: (Math.cos(angle) - 1) * az,
        vx: Math.cos(angle) * ax * omega, vy: 0, vz: -Math.sin(angle) * az * omega,
      };
    },
  },
]);

export const DEFAULT_BIN_MOTION = "still";

export function binMotionIds() {
  return BIN_MOTIONS.map(({ id }) => id);
}

/** Resolve a motion id, falling back to the default rather than throwing. */
export function binMotionById(id) {
  return BIN_MOTIONS.find((motion) => motion.id === id)
    || BIN_MOTIONS.find((motion) => motion.id === DEFAULT_BIN_MOTION);
}

/**
 * The box a motion's sweep actually occupies, MEASURED off its own path.
 *
 * Sampled over one period rather than derived from the amplitudes, because two
 * of the paths are offset cosines and travel twice their amplitude in one
 * direction only. Asymmetric on purpose — see the note on `BIN_MOTIONS`.
 *
 * Computed once per motion and cached: the paths are pure, so an envelope is a
 * property of the catalog rather than of a placement, and `clampPlacement` runs
 * on every drag event.
 */
const ENVELOPES = new Map();

export function motionEnvelope(motionId) {
  const motion = binMotionById(motionId);
  const cached = ENVELOPES.get(motion.id);
  if (cached) return cached;

  const box = { minDx: 0, maxDx: 0, minDy: 0, maxDy: 0, minDz: 0, maxDz: 0 };
  const steps = 720;
  for (let i = 0; i <= steps; i++) {
    const { dx, dy, dz } = motion.path((i / steps) * motion.period);
    box.minDx = Math.min(box.minDx, dx); box.maxDx = Math.max(box.maxDx, dx);
    box.minDy = Math.min(box.minDy, dy); box.maxDy = Math.max(box.maxDy, dy);
    box.minDz = Math.min(box.minDz, dz); box.maxDz = Math.max(box.maxDz, dz);
  }
  const frozen = Object.freeze(box);
  ENVELOPES.set(motion.id, frozen);
  return frozen;
}

/**
 * The world-x limits at a given depth: TWO bands, intersected.
 *
 * The first is the portrait crop above — the bin's outer LIP has to stay on
 * screen, so the band is pulled in by the projected reach of that lip at this
 * depth.
 *
 * The second is `AIM_MIN_X..AIM_MAX_X`, the band the reticle can swing across,
 * and it is the one that was missing. IT IS NARROWER THAN THE SCREEN, and the
 * gap is not small: at the back of the room the visible floor runs to a world x
 * of about 0.94 while the reticle stops at about 0.61. A bin placed in that gap
 * was drawn, was legal, and could not be aimed at by any pull the gesture is
 * capable of producing — a whole ring of placements around the back corners of
 * the room that simply could not be made. A sweep of every motion at every
 * corner is what found it, and `tests/horse.test.js` now pins it.
 *
 * So the rule is: YOU MAY ONLY PLACE A BIN YOU COULD SHOOT AT. Reachability of
 * the arc is still deliberately not checked — the setter shoots first, and that
 * is the rules' job — but a target outside the aiming gesture's range is not a
 * hard shot, it is a broken one.
 */
export function horizontalBoundsAt(z) {
  const lip = worldToScreenLength(MOUTH_OUTER, z);
  const centre = projectPoint({ x: 0, y: BIN_MOUTH_Y, z });
  const perWorldUnit = worldToScreenLength(1, z);
  const minScreen = Math.max(PLACEMENT_SCREEN_BOUNDS.minX + lip, AIM_MIN_X);
  const maxScreen = Math.min(PLACEMENT_SCREEN_BOUNDS.maxX - lip, AIM_MAX_X);
  if (maxScreen <= minScreen || perWorldUnit <= 0) return { minX: 0, maxX: 0 };
  return {
    minX: (minScreen - centre.x) / perWorldUnit,
    maxX: (maxScreen - centre.x) / perWorldUnit,
  };
}

/**
 * The height band at a depth, with a motion's vertical reach already taken off.
 *
 * The ceiling of it is read at the DEEPEST point the motion reaches, because
 * `maxMouthHeightAt` falls with depth — a bin that is honestly drawable at the
 * near end of its run and not at the far end is not a legal placement.
 */
export function heightBoundsAt(z, envelope = motionEnvelope(DEFAULT_BIN_MOTION)) {
  const minY = PLACEMENT_BOUNDS.minY - envelope.minDy;
  // Read at the DEEPEST point the sweep reaches, because `maxMouthHeightAt`
  // falls with depth — a bin honestly drawable at the near end of its run and
  // not at the far end is not a legal placement.
  const maxY = Math.max(minY, maxMouthHeightAt(z + envelope.maxDz) - envelope.maxDy);
  return { minY, maxY };
}

/**
 * A placement, clamped into the legal volume for the motion it carries.
 *
 * THE MOTION'S REACH IS SUBTRACTED FROM THE VOLUME rather than checked
 * afterwards, so every point the bin will visit is legal — not merely the point
 * it was placed at. Depth is clamped before x, because the horizontal limits are
 * a function of depth.
 */
export function clampPlacement(placement = {}, motionId = DEFAULT_BIN_MOTION) {
  const envelope = motionEnvelope(motionId);
  const fallback = defaultPlacement();
  const minZ = PLACEMENT_BOUNDS.minZ - envelope.minDz;
  const maxZ = Math.max(minZ, PLACEMENT_BOUNDS.maxZ - envelope.maxDz);
  const z = clamp(Number.isFinite(placement.z) ? placement.z : fallback.z, minZ, maxZ);

  const height = heightBoundsAt(z, envelope);
  const y = clamp(Number.isFinite(placement.y) ? placement.y : fallback.y, height.minY, height.maxY);

  // Read at BOTH depth extremes the sweep reaches and intersected, for the same
  // reason the height band is read at the far one.
  const near = horizontalBoundsAt(z + envelope.minDz);
  const far = horizontalBoundsAt(z + envelope.maxDz);
  const minX = Math.max(near.minX, far.minX) - envelope.minDx;
  const maxX = Math.min(near.maxX, far.maxX) - envelope.maxDx;
  const x = clamp(
    Number.isFinite(placement.x) ? placement.x : 0,
    Math.min(minX, maxX),
    Math.max(minX, maxX),
  );
  return { x, y, z };
}

/** Where a bin starts before the player has moved it: middle of the room, on the floor. */
export function defaultPlacement() {
  return {
    x: 0,
    y: BIN_BODY_HEIGHT,
    z: (PLACEMENT_BOUNDS.minZ + PLACEMENT_BOUNDS.maxZ) / 2,
  };
}

/**
 * A placement expressed as fractions of the legal volume.
 *
 * `depth` and `height` run 0..1 across what is legal for the motion; `lateral`
 * runs -1..1 out from the middle of the room. This is the seam the CPU places
 * through, so `sim/horse.js` can decide how bold a bin to set without owning any
 * geometry — and it means a deeper or taller room automatically makes the CPU's
 * bold placements bolder, with nothing in the rules re-tuned.
 */
export function placementFromFractions({ lateral = 0, depth = 0.5, height = 0 } = {}, motionId = DEFAULT_BIN_MOTION) {
  const envelope = motionEnvelope(motionId);
  const span = (min, max) => Math.max(0, max - min);

  const minZ = PLACEMENT_BOUNDS.minZ - envelope.minDz;
  const maxZ = Math.max(minZ, PLACEMENT_BOUNDS.maxZ - envelope.maxDz);
  const z = minZ + clamp(depth, 0, 1) * span(minZ, maxZ);

  const band = heightBoundsAt(z, envelope);
  const y = band.minY + clamp(height, 0, 1) * span(band.minY, band.maxY);

  // A symmetric half-width out from the middle of the room, so `lateral` means
  // the same distance either side even when the sweep itself is lopsided; the
  // clamp below is what makes a lopsided one legal.
  const bounds = horizontalBoundsAt(z);
  const sideways = Math.max(-envelope.minDx, envelope.maxDx);
  const halfWidth = Math.max(0, Math.min(-bounds.minX, bounds.maxX) - sideways);
  return clampPlacement({ x: clamp(lateral, -1, 1) * halfWidth, y, z }, motionId);
}

/** A complete, validated shot setup: where the bin is and what it does. */
export function normalizeBinSetup(value = {}) {
  const motionId = binMotionById(value.motionId).id;
  return { ...clampPlacement(value.placement || value, motionId), motionId };
}

/**
 * The bin as the physics and the renderer see it, at a moment in the turn.
 *
 * A pure function of elapsed seconds, exactly like `hoopAt`: it reads no clock,
 * so the same setup replayed tick-for-tick puts the bin in exactly the same
 * place. That is what lets the matching player face the shot the setter actually
 * faced — both turns start this clock at zero.
 */
export function placedBinAt(setup, elapsedSeconds = 0) {
  const { motionId, x, y, z } = normalizeBinSetup(setup);
  const seconds = Math.max(0, Number(elapsedSeconds) || 0);
  const { dx, dy, dz, vx, vy, vz } = binMotionById(motionId).path(seconds);
  const topY = y + dy;
  return createBin({
    index: 0,
    x: x + dx,
    topY,
    z: z + dz,
    baseY: topY - BIN_BODY_HEIGHT,
    velocity: { x: vx, y: vy, z: vz },
  });
}
