// World <-> screen mapping for the cabinet's pseudo-3D room.
//
// The room is a flat painted backdrop; the sense of depth comes entirely from
// this file. Everything else — the ball, the rim, the trajectory preview, the
// shadow, the splats — is drawn by projecting world points through here, so the
// whole scene stays on one consistent perspective.
//
// ONE CAMERA, NOT TWO NUMBERS. A point's depth does two things: it shrinks the
// point, and it raises the floor line the point is measured from. Those two are
// the SAME fact about a pinhole camera and this file derives the second from the
// first — the floor at depth z is exactly the horizon plus the front floor's
// distance below the horizon, shrunk by the depth scale. A ground point at
// infinite depth lands on the horizon, which is what a horizon is.
//
// They used to be independent: the scale shrank hyperbolically while the floor
// line rose linearly, at a rate that happened to be about half what the painted
// rooms wanted. Nothing in the scene was internally wrong, but nothing agreed
// with the picture behind it — the back wall drew where the middle of the floor
// was painted, and the room read flat. Keeping these two derived from one
// another is what makes that class of bug impossible rather than merely fixed.
//
// Every function is pure. No canvas, no state, no DOM.

import {
  BALL_MIN_SCREEN_RADIUS,
  BALL_SCREEN_RADIUS,
  CEILING_Y,
  DEPTH_FALLOFF,
  FLOOR_SCREEN_Y,
  FLOOR_Y,
  HORIZON_SCREEN_Y,
  PROJECTION_ORIGIN_X,
  PROJECTION_X_SCALE,
  PROJECTION_Y_SCALE,
  RIM_CENTER_Z,
} from "./constants.js";

// A ball that overshoots hard can leave the playable depth band. Clamping keeps
// the projection well-defined instead of letting the scale term cross zero and
// flip the scene inside out.
const MIN_Z = -0.12;
const MAX_Z = 1.22;

export function clampDepth(z) {
  return Math.max(MIN_Z, Math.min(MAX_Z, z));
}

/** How much a world unit at depth `z` shrinks on screen. 1 at the camera plane. */
export function depthScaleAt(z) {
  return 1 / (1 + DEPTH_FALLOFF * clampDepth(z));
}

/**
 * The scanline a ground-level point at depth `z` is measured from.
 *
 * Derived from `depthScaleAt`, not tuned beside it: the floor recedes toward the
 * horizon at exactly the rate the world shrinks, because in a real camera those
 * are one fact. Do not give this its own constant.
 */
export function floorScreenY(z) {
  return HORIZON_SCREEN_Y + (FLOOR_SCREEN_Y - HORIZON_SCREEN_Y) * depthScaleAt(z);
}

/** Project a world point to canvas pixels. */
export function projectPoint({ x, y, z }) {
  const scale = depthScaleAt(z);
  return {
    x: PROJECTION_ORIGIN_X + x * PROJECTION_X_SCALE * scale,
    y: floorScreenY(z) - (y - FLOOR_Y) * PROJECTION_Y_SCALE * scale,
    scale,
  };
}

/**
 * The scanline the ceiling crosses at depth `z`.
 *
 * The floor line's mirror: it converges on the same horizon from above, because
 * both planes are horizontal and a camera has one vanishing line for all of
 * them. Nothing in the game is drawn from this — the ceiling is painted — but it
 * is what `tools/room-contact-sheet.mjs` draws to check that the height the
 * physics stops the ball at is the height the art puts the ceiling at.
 */
export function ceilingScreenY(z) {
  return projectPoint({ x: 0, y: CEILING_Y, z }).y;
}

/**
 * Invert `projectPoint` onto a known depth plane.
 *
 * A single screen point maps to a whole ray in world space, so the caller has to
 * supply the `z` it means — which is exactly how aiming works here: the player
 * picks a spot on the rim plane, not a spot in free space.
 */
export function screenToWorldAtZ(screenX, screenY, z) {
  const scale = depthScaleAt(z);
  return {
    x: (screenX - PROJECTION_ORIGIN_X) / (PROJECTION_X_SCALE * scale),
    y: (floorScreenY(z) - screenY) / (PROJECTION_Y_SCALE * scale) + FLOOR_Y,
    z,
  };
}

/**
 * How long a world-space length is on screen at depth `z`.
 *
 * The honest perspective term, with no floor under it — unlike
 * `ballScreenRadius`, which clamps so a ball that overshoots the room stays
 * visible. Anything painted ONTO the room wants this instead: a mark on the
 * back wall is genuinely half the size of the same mark at the player's feet,
 * and a clamp would flatten exactly the depth it is there to show.
 */
export function worldToScreenLength(length, z) {
  return length * PROJECTION_X_SCALE * depthScaleAt(z);
}

/**
 * The screen ellipse traced by a HORIZONTAL RING of world radius `worldRadius`
 * whose centre projects to `(centreScreenX, centreScreenY)` on the depth plane
 * `z`.
 *
 * This is the rim, the net's hem, and every ring of cords in between. It exists
 * because those used to be drawn at a FIXED width and a FIXED height, and only
 * the width was ever right.
 *
 * How open a ring looks is entirely a function of how far it is from EYE LEVEL,
 * and eye level on this camera is `HORIZON_SCREEN_Y`. A ring level with the eye
 * is a line; one well above or below it is close to a circle. The rim in this
 * cabinet rides 174..272 on screen against a horizon at 298, so its honest
 * half-height swings by better than four to one over the travel of a single
 * motion mode — drawn as a constant, the rim slides around as a rigid decal
 * instead of hanging in the room.
 *
 * `fromBelow` says which side of eye level the ring is on, and therefore which
 * arc is the FAR one: looking UP at a ring, its near edge draws HIGHER on screen
 * than its far edge, and the whole near/far split of `render/hoop.js` inverts.
 * That is not a detail — it decides which cords the ball passes behind.
 *
 * The centre is returned as `cy` rather than assumed to be `centreScreenY`: the
 * near half of a ring is nearer the camera and so projects LARGER, which pushes
 * the ellipse's centre a little off the ring's own centre. A couple of pixels,
 * but it is free and it is the difference between a projected circle and a
 * drawn one.
 */
export function ringEllipseAt(centreScreenX, centreScreenY, worldRadius, z = RIM_CENTER_Z) {
  const centre = screenToWorldAtZ(centreScreenX, centreScreenY, z);
  const near = projectPoint({ x: centre.x, y: centre.y, z: z - worldRadius });
  const far = projectPoint({ x: centre.x, y: centre.y, z: z + worldRadius });
  return {
    cx: centreScreenX,
    cy: (near.y + far.y) / 2,
    radiusX: worldToScreenLength(worldRadius, z),
    radiusY: Math.abs(far.y - near.y) / 2,
    fromBelow: near.y < far.y,
  };
}

/** Draw radius of the ball sprite at depth `z`. */
export function ballScreenRadius(z) {
  return Math.max(BALL_MIN_SCREEN_RADIUS, BALL_SCREEN_RADIUS * depthScaleAt(z));
}

/**
 * Convert a screen-space velocity at depth `z` into world units.
 *
 * The hoop moves along screen paths (that is how the modes are authored and how
 * they read to the player), but collisions have to resolve against a velocity in
 * the same space as the ball. Note the sign flip on the vertical axis: screen y
 * grows downward, world y grows upward.
 */
export function screenVelocityToWorld(vxScreen, vyScreen, z) {
  const scale = depthScaleAt(z);
  return {
    vx: vxScreen / (PROJECTION_X_SCALE * scale),
    vy: -vyScreen / (PROJECTION_Y_SCALE * scale),
  };
}
