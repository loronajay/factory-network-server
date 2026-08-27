// Reusable trash-bin geometry and ball integration. A bin is not a score zone:
// it is a tapered body plus a torus lip, with a descending mouth-plane crossing
// registering the make. The same target objects can be reused by later modes.
//
// THE BIN IS THE ONLY DEFINITION OF WHERE IT IS. `render/bin.js` draws the
// `open-bin.png` sprite ANCHORED to these numbers — its painted mouth is placed
// on the mouth `detectBinScore` tests, at every row's depth — rather than sized
// beside them off a hand-tuned ratio. That was the bug: the drawn bin and the
// tested mouth were two independent answers, and at the front row they differed
// by 23px of width.
//
// THE ROOM IS THE CLASSIC ROOM. Floor, ceiling and back wall resolve through
// `sim/collision.js` — the same resolvers the classic cabinet runs — rather than
// through a private copy. The copy this replaced scrubbed 28% of the ball's
// horizontal speed EVERY SUBSTEP it spent on the floor, which is 125 times a
// second: a ball that landed anywhere but in a bin stopped dead on the spot
// instead of rolling out, and that alone is most of what read as the physics
// being wrong.

import { ballFlight, ballSplatsOn, rollPhasePerRadian } from "../assets/ball-catalog.js";
import {
  BALL_RADIUS_WORLD,
  BOARD_Z,
  DEPTH_FALLOFF,
  FLOOR_SCREEN_Y,
  FLOOR_Y,
  GRAVITY,
  HORIZON_SCREEN_Y,
  PHYSICS_SUBSTEP_SECONDS,
  PROJECTION_Y_SCALE,
  SPIN_DECAY_PER_TICK,
  WALL_RESTITUTION,
} from "./constants.js";
import { resolveCeilingContact, resolveFloorContact } from "./collision.js";
import { depthScaleAt, projectPoint, tiltedRingEllipseAt } from "./projection.js";

// The mouth a ball has to find. The ball is 0.078 across the radius, so the
// clear opening `binClearance` leaves is a little under one ball-radius of slack
// on either side.
//
// THE MOUTH IS AS WIDE AS THE ROOM ALLOWS, AND THE BINS TOUCH. Widening it looks
// like the obvious kindness and it is not available: the rows sit 0.27 apart,
// which is all the depth there is between a ball resting at z=0 and a back wall
// the ball cannot pass at z=0.92, and at this width neighbouring lips already
// overlap by about 0.098. Every non-overlapping layout that fits in the room
// leaves a clearance of 0.035 or less — half of what is here — so a bin grid
// with gaps between the bins is a strictly harder game, not a fairer one. The
// overlap is therefore deliberate, and `nearestBinTo` below is what keeps it
// honest.
//
// So the difficulty is fixed by the room, and the thing that was actually wrong
// was never this number: it was that the drawn bin did not stand where this one
// says it does. The old placement put a 71px-wide sprite around a 94px physical
// mouth at the front row; `render/bin.js` now anchors the art to these numbers.
export const BIN_MOUTH_Y = 0.36;

/**
 * THE BIN, AS MEASURED OFF `assets/modes/floor-tic-tac-toe/open-bin.png`.
 *
 * The art is the object and the collider is the description of it, so the
 * description is taken FROM the picture rather than typed beside it. Every
 * number here is in source-image pixels and every one was walked off the file by
 * `tools/measure-bin.mjs`, not eyeballed:
 *
 *   mouthCenter / mouthRadius  a least-squares fit of the rim's OUTER silhouette
 *                              across 910 columns, residual 0.57px. It is the
 *                              painted opening, and it is what the world mouth
 *                              is scaled and leaned to land on.
 *   beadThickness              the rim bead's RADIAL thickness, read at the
 *                              ellipse's own centre row — the one place the bead
 *                              is seen edge-on with no foreshortening, and clean
 *                              on both sides (39px left, 36px right; the
 *                              interior falls off a cliff at both).
 *   baseY                      the last row with paint in it.
 *
 * The numbers this replaced were wrong in the two ways that mattered. The mouth
 * ellipse was recorded as centre 160 / semi-axis 116, which shares a far edge
 * with the truth and hangs 15px past its near edge — so the collider sat low and
 * proud of the hole. And the bead was implied to be 113px thick by a
 * `BIN_RIM_TUBE_RADIUS` of 0.022 against a 37px paint, THREE TIMES too fat: the
 * ball was being turned away by a lip two-thirds of which was not drawn.
 */
export const BIN_ART = Object.freeze({
  width: 1187,
  height: 1326,
  mouthCenterX: 588.5,
  mouthCenterY: 152.3,
  mouthRadiusX: 469.5,
  mouthRadiusY: 108.5,
  beadThickness: 37.5,
  baseY: 1275,
  // The body's own half-width where it meets the floor, from the same walk.
  baseRadiusX: 370,
});

// How far out the rim reaches, in world units. THE one number here that is a
// choice rather than a reading — it fixes the bin's size in the room, and
// everything else about the mouth is the art's proportions applied to it. It is
// unchanged from the shipped value (0.16 + 0.022), so the sprite draws at
// exactly the size it always did and nothing about the board's layout moved.
const BIN_MOUTH_OUTER_RADIUS = 0.182;

const perArtPixel = BIN_MOUTH_OUTER_RADIUS / BIN_ART.mouthRadiusX;

// THE LIP IS AS THICK AS THE LIP IN THE PICTURE. This was 0.022 — a bead 113
// source pixels thick against a painted 37 — and that single number was most of
// what made the mode feel like it was lying: the collider's opening came out at
// 0.138 where the hole you can see is 0.168, so a ball that visibly cleared the
// rim clanged off a lip drawn 18% further in than it really was.
export const BIN_RIM_TUBE_RADIUS = (BIN_ART.beadThickness / 2) * perArtPixel;

// The ring through the middle of that bead. Derived, so it cannot drift away
// from the outer reach and the bead thickness that define it.
export const BIN_MOUTH_RADIUS = BIN_MOUTH_OUTER_RADIUS - BIN_RIM_TUBE_RADIUS;

export const BIN_BOTTOM_RADIUS = BIN_ART.baseRadiusX * perArtPixel;
export const BIN_WALL_THICKNESS = 0.016;

// THE MOUTH IS THE PAINTED MOUTH. The bin's opening in `open-bin.png` is an
// ellipse 116/468 = 0.248 as tall as it is wide, because the bin was
// photographed from very near eye level. A HORIZONTAL circle through this
// cabinet's camera is 0.42 at the back row and 0.59 at the front — nearly two
// and a half times rounder — so a horizontal mouth collider sits visibly proud
// of the hole it is supposed to be, and every lip strike near the front or back
// of a mouth happens off-picture. That is what made the mode feel disconnected
// from its own art.
//
// The art is not the thing that is wrong, and it is not what moves. A horizontal
// disc is only ONE of the planes that projects to a given ellipse: leaning the
// mouth's plane away from the camera closes the ellipse without touching its
// width, so there is a lean at which the collider projects EXACTLY onto the
// painted opening. `solveBinMouthTilt` finds it, per row, against the real
// projection. The bin reads as standing very slightly back on its heel, which is
// precisely what the photograph shows.
//
// It was previously recorded here as unclosable, on the grounds that a mouth
// whose world DEPTH matched the paint would be 0.13 across against a 0.156 ball.
// That is true and it is the wrong measurement: it assumes the mouth stays
// horizontal and gets squashed. A leaning mouth keeps its full 0.16 radius IN
// ITS OWN PLANE — the ball drops through the same hole it always did. All the
// lean costs is `cos(tilt)` off the opening's front-to-back footprint, about 6%
// at the front row and 2% at the back.
export const BIN_PAINTED_MOUTH_ASPECT = BIN_ART.mouthRadiusY / BIN_ART.mouthRadiusX;

/**
 * The lean, in radians, at which this bin's mouth projects onto the painted one.
 *
 * Solved rather than derived in closed form: the exact projection is not linear
 * in depth, and this is computed nine times when the board is built. Bisection
 * runs over [0, `flattestTilt`] because the drawn height falls monotonically to
 * zero across that range — past it the ring opens out again the other way, which
 * is a second solution describing a mouth tipped past edge-on.
 */
export function solveBinMouthTilt(bin) {
  const aspectAt = (tilt) => {
    const centre = projectPoint({ x: bin.x, y: bin.topY, z: bin.z });
    const ring = tiltedRingEllipseAt(centre.x, centre.y, bin.mouthRadius + bin.rimTubeRadius, bin.z, tilt);
    return ring.radiusY / ring.radiusX;
  };
  if (aspectAt(0) <= BIN_PAINTED_MOUTH_ASPECT) return 0;

  let lo = 0;
  let hi = flattestTilt(bin);
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (aspectAt(mid) > BIN_PAINTED_MOUTH_ASPECT) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The lean at which the mouth draws edge-on — a flat line — and the far end of
 * the bracket the solve runs in.
 *
 * A ring point's screen height moves with BOTH the depth it gains and the world
 * height it loses, and those two pull opposite ways. This is the angle at which
 * they cancel exactly, from the camera's own two derivatives at the mouth.
 */
function flattestTilt(bin) {
  const scale = depthScaleAt(bin.z);
  const perDepth = DEPTH_FALLOFF * scale * scale
    * ((FLOOR_SCREEN_Y - HORIZON_SCREEN_Y) - (bin.topY - FLOOR_Y) * PROJECTION_Y_SCALE);
  const perHeight = PROJECTION_Y_SCALE * scale;
  return Math.atan2(Math.abs(perDepth), Math.abs(perHeight));
}

/**
 * The height of a bin's mouth plane at depth `z`.
 *
 * The plane leans back, so it rises toward the player and drops toward the wall.
 * This is the whole of the tilt as the rest of the file sees it.
 */
export function binMouthPlaneY(bin, z) {
  return bin.topY - bin.mouthTilt.tan * (z - bin.z);
}

/**
 * A point's offset from the mouth's centre, in the mouth's OWN plane.
 *
 * `u` runs sideways and `v` runs up-the-slope toward the wall; `normal` is how
 * far the point stands off the plane, positive on the side the ball arrives
 * from. Every mouth test in this file is one of these three numbers, which is
 * what keeps the lean from leaking into the rest of the geometry.
 */
export function binMouthFrame(bin, point) {
  const { sin, cos } = bin.mouthTilt;
  const dy = point.y - bin.topY;
  const dz = point.z - bin.z;
  return {
    u: point.x - bin.x,
    v: dz * cos - dy * sin,
    normal: dy * cos + dz * sin,
  };
}

// The front row deliberately starts at z=.33. A target body has real depth and
// the held ball has real radius; moving it closer would make the ball begin its
// shot already intersecting the front wall of the nearest bin.
const ROW_Z = Object.freeze([0.87, 0.60, 0.33]);
const COLUMN_X = Object.freeze([-0.5, 0, 0.5]);
const SEPARATION = 0.0015;

// The board's own layout, published so the floor grid is DRAWN FROM IT rather
// than from a second set of numbers typed beside it.
//
// It used to be exactly that second set, and it was wrong in both directions at
// once. Its rows ran the other way — the panel for cell 0 was painted at the
// FRONT of the room while bin 0 stands at the back — so every claimed cell lit
// up mirrored north/south, three rows away from the mark it belonged to. And its
// cells were centred on `ROW_Z`, which sounds right and does not look it; see
// `BIN_APPARENT_FOOT_OFFSET`.
export const BIN_GRID_ROW_Z = ROW_Z;
export const BIN_GRID_COLUMN_X = COLUMN_X;
export const BIN_GRID_ROW_DEPTH = ROW_Z[1] - ROW_Z[2];
export const BIN_GRID_COLUMN_WIDTH = COLUMN_X[1] - COLUMN_X[0];

/**
 * How far NEARER the camera a drum looks than the point it stands on.
 *
 * A drum standing at `z` covers floor from `z - bottomRadius` to
 * `z + bottomRadius`, so centring its cell on `z` is geometrically exact — and
 * it reads as the bin spilling forward out of its own cell, because the far half
 * of that footprint is HIDDEN BEHIND THE DRUM. All the eye is given is the near
 * base edge, and the near base edge lands precisely on the cell's front line.
 *
 * So the cell is centred on the footprint the player can actually see, which
 * runs from the near base edge to the axis: a half-radius nearer than the bin.
 * Nothing about the collider moves — the rows are still 0.27 apart at 0.33 /
 * 0.60 / 0.87, the make rate is untouched, and the difficulty levers are still
 * the row spacing and `BIN_MOUTH_OUTER_RADIUS`. This is the PAINT catching up
 * with where the bins visibly stand, which is the only honest direction: at
 * z=0.87 the back row is already close enough to the wall at BOARD_Z that it
 * cannot be pushed back.
 */
export const BIN_APPARENT_FOOT_OFFSET = BIN_BOTTOM_RADIUS / 2;

/**
 * The floor panel under one cell, indexed EXACTLY as `bin.index` is: row 0 is
 * the back row, because `createBinTargets` builds row 0 from `ROW_Z[0]`.
 */
export function binGridCell(row, column) {
  const centreZ = ROW_Z[row] - BIN_APPARENT_FOOT_OFFSET;
  const halfDepth = BIN_GRID_ROW_DEPTH / 2;
  const halfWidth = BIN_GRID_COLUMN_WIDTH / 2;
  return {
    index: row * 3 + column,
    row,
    column,
    minX: COLUMN_X[column] - halfWidth,
    maxX: COLUMN_X[column] + halfWidth,
    minZ: centreZ - halfDepth,
    maxZ: centreZ + halfDepth,
  };
}

/** Every cell, in `bin.index` order. */
export function binGridCells() {
  return ROW_Z.flatMap((_, row) => COLUMN_X.map((__, column) => binGridCell(row, column)));
}

/**
 * How far from a bin's axis the ball has to be before that bin cannot possibly
 * be touching it. A cheap reject in front of the two real resolvers.
 *
 * Nine bins by two resolvers by 125 substeps a second is not expensive, but the
 * reject buys something better than speed: it is a single statement of a bin's
 * reach, so a ball flying between two of them is provably clear of both, rather
 * than being separately declared clear by two solvers that each nearly matched.
 */
const BIN_REACH = BIN_MOUTH_RADIUS + BIN_WALL_THICKNESS + BIN_RIM_TUBE_RADIUS + BALL_RADIUS_WORLD;

/** A bin that is not going anywhere. Shared, because the common case is most of them. */
const AT_REST = Object.freeze({ x: 0, y: 0, z: 0 });

/**
 * One bin, anywhere, moving or not.
 *
 * THE ONE FACTORY. Tic-Tac-Toe's nine grid bins and HORSE's single placed bin
 * are the same object built two ways, which is what lets both modes run the same
 * two resolvers and the same renderer.
 *
 * `baseY` is the height the drum's FOOT stands at, and it is a real field rather
 * than an assumed zero because a HORSE bin can hang in the air. A raised bin is
 * the same bin lifted whole — `topY - baseY` is constant — never a stretched
 * one: the sprite draws at one uniform scale, so a stretched collider would put
 * it straight back out of agreement with its own picture.
 *
 * `velocity` is the world-space velocity of the whole assembly. Zero for a
 * grid bin, so nothing about Tic-Tac-Toe changes; for a moving bin it is what
 * the two resolvers subtract before they bounce the ball, so a lip travelling
 * into the ball hits it rather than politely waiting for it.
 */
export function createBin({
  index = 0,
  row = 0,
  column = 0,
  x = 0,
  z = 0.6,
  topY = BIN_MOUTH_Y,
  baseY = FLOOR_Y,
  velocity = null,
} = {}) {
  const bin = {
    index,
    row,
    column,
    x,
    z,
    topY,
    baseY,
    mouthRadius: BIN_MOUTH_RADIUS,
    bottomRadius: BIN_BOTTOM_RADIUS,
    rimTubeRadius: BIN_RIM_TUBE_RADIUS,
    wallThickness: BIN_WALL_THICKNESS,
    velocity: velocity
      ? Object.freeze({
        x: Number(velocity.x) || 0,
        y: Number(velocity.y) || 0,
        z: Number(velocity.z) || 0,
      })
      : AT_REST,
    mouthTilt: { angle: 0, sin: 0, cos: 1, tan: 0, rise: 0 },
  };
  // Solved once, when the bin is built, and frozen in: it is a property of the
  // bin's depth and the art. A moving bin is rebuilt every tick, so its lean
  // tracks its depth for free.
  const angle = solveBinMouthTilt(bin);
  bin.mouthTilt = Object.freeze({
    angle,
    sin: Math.sin(angle),
    cos: Math.cos(angle),
    tan: Math.tan(angle),
    // How far the near lip stands above `topY` — the reach the mouth gains
    // upward once it leans, which the cheap reject below has to allow for.
    rise: (BIN_MOUTH_RADIUS + BIN_RIM_TUBE_RADIUS) * Math.sin(angle),
  });
  return Object.freeze(bin);
}

export function createBinTargets() {
  return ROW_Z.flatMap((z, row) => COLUMN_X.map((x, column) => createBin({
    index: row * 3 + column,
    row,
    column,
    x,
    z,
    topY: BIN_MOUTH_Y,
    baseY: FLOOR_Y,
  })));
}

/** Is the ball anywhere near enough to this bin for a contact to be possible? */
export function withinBinReach(ball, bin) {
  // `mouthTilt.rise` is what the near lip gains once the mouth leans. Without it
  // the reject would cut the ball off above a lip that is genuinely there.
  if (ball.y > bin.topY + bin.mouthTilt.rise + BALL_RADIUS_WORLD + bin.rimTubeRadius) return false;
  // And below the foot there is nothing at all. Always true for a grid bin,
  // which stands on the floor; load-bearing for a raised HORSE bin, where a ball
  // rolling underneath must not be claimed by a drum hanging above it.
  if (ball.y < bin.baseY - BALL_RADIUS_WORLD) return false;
  return Math.hypot(ball.x - bin.x, ball.z - bin.z) <= BIN_REACH;
}

/**
 * The one bin the ball is touching, if any: the nearest whose reach it is inside.
 *
 * ONE BIN PER SUBSTEP, and this is the rule that makes the deliberate overlap
 * above liveable. Neighbouring lips share about 0.098 of world space, so a ball
 * descending near a row boundary is genuinely inside two tori at once — and two
 * resolvers each correcting it out of their own ring, in list order, hand it an
 * impulse from a collision that never happened. That is what a rattle between
 * rows used to be: not a bounce off a rim, but the same contact solved twice.
 *
 * Nearest-by-axis is the honest reading of an overlap, because the deeper of two
 * intersecting bins is behind the shallower one — the lip the ball can actually
 * reach is the near one, and the far one's is buried inside it.
 */
export function nearestBinTo(ball, bins) {
  let nearest = null;
  let best = Infinity;
  for (const bin of bins) {
    if (!withinBinReach(ball, bin)) continue;
    const distance = Math.hypot(ball.x - bin.x, ball.z - bin.z);
    if (distance < best) {
      best = distance;
      nearest = bin;
    }
  }
  return nearest;
}

/**
 * The clear opening: how far off-axis the ball's CENTRE may be at the mouth
 * plane and still drop in.
 *
 * Exported because the screen tests check the drawn lip and this circle share
 * one scale at every row. A renderer that computed its own version of it would
 * be the placement mismatch back in a new form.
 */
export function binClearance(bin) {
  // THE MAKE WINDOW IS THE PAINTED HOLE, LESS THE BALL. `mouthRadius -
  // rimTubeRadius` is the bead's inner edge, which is the dark opening in the
  // picture; take the ball's radius off it and what is left is how far off-axis
  // its centre may be and still fit. Nothing is fudged in either direction.
  //
  // It used to shave only 0.55 of the tube, which was a nudge back toward
  // playability against a lip three times too thick. With the bead measured off
  // the art the fudge has nothing left to correct.
  return bin.mouthRadius - bin.rimTubeRadius - BALL_RADIUS_WORLD;
}

/**
 * Did the ball just drop through this mouth?
 *
 * A crossing of the LEANING mouth plane, measured along that plane's normal, and
 * then a distance inside the plane. It used to be a crossing of `y = topY` and a
 * distance in the horizontal — the same test, for the horizontal mouth this one
 * replaced.
 */
export function detectBinScore(ball, previous, bin) {
  // RELATIVE to the mouth, not to the room. A bin riding upward faster than a
  // ball is falling has not been scored in — it has come up to meet the ball,
  // and what happens next is a lip strike. Zero for a still bin, so the grid
  // board's test is untouched.
  if (ball.vy - bin.velocity.y >= 0) return false;
  const before = binMouthFrame(bin, previous).normal;
  const after = binMouthFrame(bin, ball);
  if (before <= 0 || after.normal > 0) return false;
  const drop = before - after.normal;
  if (drop <= 1e-7) return false;
  const t = before / drop;
  const crossing = {
    x: previous.x + (ball.x - previous.x) * t,
    y: previous.y + (ball.y - previous.y) * t,
    z: previous.z + (ball.z - previous.z) * t,
  };
  const { u, v } = binMouthFrame(bin, crossing);
  return Math.hypot(u, v) < binClearance(bin);
}

/**
 * The lip: a torus around the mouth's ring, IN THE MOUTH'S OWN PLANE.
 *
 * Identical to the horizontal version it replaces except that the nearest point
 * on the ring is found in the plane's `(u, v)` basis rather than in the world
 * horizontal — so the lip the ball strikes is the lip in the picture.
 */
export function resolveBinRimContact(ball, bin, flight = { bounce: 1, grip: 1 }) {
  const { sin, cos } = bin.mouthTilt;
  const { u, v } = binMouthFrame(bin, ball);
  const radial = Math.hypot(u, v);
  if (radial < 1e-7) return null;
  const ringU = (bin.mouthRadius * u) / radial;
  const ringV = (bin.mouthRadius * v) / radial;
  // Back out of the plane basis: e1 = (1, 0, 0), e2 = (0, -sin, cos).
  const cx = bin.x + ringU;
  const cy = bin.topY - ringV * sin;
  const cz = bin.z + ringV * cos;
  let nx = ball.x - cx;
  let ny = ball.y - cy;
  let nz = ball.z - cz;
  const distance = Math.hypot(nx, ny, nz);
  const contact = BALL_RADIUS_WORLD + bin.rimTubeRadius;
  if (distance >= contact || distance < 1e-7) return null;
  nx /= distance; ny /= distance; nz /= distance;
  const penetration = contact - distance + SEPARATION;
  ball.x += nx * penetration;
  ball.y += ny * penetration;
  ball.z += nz * penetration;
  // The closing speed along the normal, measured against the LIP rather than
  // against the room. Reflecting the relative velocity is what lets a moving bin
  // hand the ball an impulse instead of behaving like a wall that happens to be
  // sliding. `velocity` is zero for every grid bin, so this is exactly the old
  // arithmetic there.
  const normalSpeed = (ball.vx - bin.velocity.x) * nx
    + (ball.vy - bin.velocity.y) * ny
    + (ball.vz - bin.velocity.z) * nz;
  if (normalSpeed < 0) {
    // Plastic, not the classic cabinet's steel: deader than RIM_RESTITUTION, so
    // a lip strike drops toward the floor instead of pinballing across the board
    // and falling into somebody else's cell.
    const restitution = Math.max(0, Math.min(0.86, 0.46 * (flight.bounce ?? 1)));
    ball.vx -= (1 + restitution) * normalSpeed * nx;
    ball.vy -= (1 + restitution) * normalSpeed * ny;
    ball.vz -= (1 + restitution) * normalSpeed * nz;
    const grip = Math.min(0.3, 0.12 * (flight.grip ?? 1));
    ball.vx *= 1 - grip;
    ball.vz *= 1 - grip;
  }
  return "bin-rim";
}

/**
 * The bin's side wall.
 *
 * THE WALL STOPS AT THE MOUTH PLANE, and that bound is load-bearing. It used to
 * run to `topY + BALL_RADIUS_WORLD`, which put a full-height cylinder of
 * horizontal normal in the 7.8cm of air ABOVE the mouth — where the only thing
 * that actually exists is the rim torus, and `resolveBinRimContact` already owns
 * it. The cost was not subtle: a ball lobbed at the back row leaves the floor
 * climbing steeply, and on its way up it passes through that phantom band about
 * 8cm to the near side of the front bin. The wall resolver reversed its `vz`,
 * so a full-power shot at the back row bounced straight back at the player from
 * a surface that was neither drawn nor there. Above the mouth plane the rim is
 * the only collider, which is also what makes lobbing over a row possible.
 */
export function resolveBinWallContact(ball, previous, bin, flight = { bounce: 1 }) {
  // NOTE the bound is still `topY` and NOT the leaning mouth plane. The plane
  // rises toward the player, and following it here would push a horizontal
  // normal back up into the air on the near side — which is the phantom band
  // this bound was introduced to delete. The drum is upright, which is also what
  // the sprite paints; only its mouth leans.
  //
  // THE DRUM ALSO HAS A FOOT, and a HORSE bin's foot need not be the floor. The
  // band below it is open air the ball passes straight under — which is what
  // makes a raised bin a genuinely different target rather than a floor bin
  // drawn higher up. For a grid bin `baseY` is 0 and this is the old guard
  // exactly.
  if (ball.y <= bin.baseY + BALL_RADIUS_WORLD || ball.y >= bin.topY) return null;
  const span = bin.topY - bin.baseY;
  if (span <= 1e-6) return null;
  const height = Math.max(0, Math.min(1, (ball.y - bin.baseY) / span));
  const bodyRadius = bin.bottomRadius + (bin.mouthRadius - bin.bottomRadius) * height;
  const dx = ball.x - bin.x;
  const dz = ball.z - bin.z;
  const radial = Math.hypot(dx, dz);
  if (radial < 1e-7) return null;
  const insideLimit = bodyRadius - BIN_WALL_THICKNESS - BALL_RADIUS_WORLD;
  const outsideLimit = bodyRadius + BIN_WALL_THICKNESS + BALL_RADIUS_WORLD;
  if (radial < insideLimit || radial > outsideLimit) return null;

  const previousRadial = Math.hypot(previous.x - bin.x, previous.z - bin.z);
  const fromInside = previousRadial < bodyRadius;
  const ux = dx / radial;
  const uz = dz / radial;
  const normalSign = fromInside ? -1 : 1;
  const nx = ux * normalSign;
  const nz = uz * normalSign;
  const target = fromInside ? insideLimit - SEPARATION : outsideLimit + SEPARATION;
  ball.x = bin.x + ux * target;
  ball.z = bin.z + uz * target;
  // Relative to the moving drum — see `resolveBinRimContact`. Zero for a grid bin.
  const normalSpeed = (ball.vx - bin.velocity.x) * nx + (ball.vz - bin.velocity.z) * nz;
  if (normalSpeed < 0) {
    const bounce = Math.min(0.72, 0.3 * (flight.bounce ?? 1));
    ball.vx -= (1 + bounce) * normalSpeed * nx;
    ball.vz -= (1 + bounce) * normalSpeed * nz;
    // A glancing scrape down the outside of a bin should not eat the fall. This
    // was 0.88 and fired once per substep, so a ball brushing past a bin lost
    // most of its descent to a contact the player could not even see.
    ball.vy *= 0.94;
  }
  return "bin-wall";
}

export function stepBallAgainstBins(ball, bins, tickSeconds, { ballId = "basketball", capturedBin = null } = {}) {
  if (ball.splat) return { contacts: [], scoredBin: null, capturedBin, splat: null };
  const substeps = Math.max(1, Math.ceil(tickSeconds / PHYSICS_SUBSTEP_SECONDS));
  const dt = tickSeconds / substeps;
  const flight = ballFlight(ballId);
  const gravity = GRAVITY * flight.weight;
  const dragKeep = flight.drag > 0 ? Math.exp(-flight.drag * dt) : 1;
  const phasePerRadian = rollPhasePerRadian(ballId);
  const contacts = [];
  let scoredBin = null;
  let capture = capturedBin;
  let splat = null;

  for (let step = 0; step < substeps; step++) {
    const hits = [];
    const previous = { x: ball.x, y: ball.y, z: ball.z };
    ball.vy -= gravity * dt;
    ball.vx *= dragKeep; ball.vy *= dragKeep; ball.vz *= dragKeep;
    ball.x += ball.vx * dt; ball.y += ball.vy * dt; ball.z += ball.vz * dt;
    ball.omegaX *= Math.pow(SPIN_DECAY_PER_TICK, dt * 60);
    ball.rollPhase += ball.omegaX * dt * phasePerRadian;

    if (capture === null) {
      // Asked FIRST, for the reason `sim/physics.js` asks it first: a clean drop
      // must never be stolen by a lip resolver nudging the ball a fraction wide.
      for (const bin of bins) {
        if (detectBinScore(ball, previous, bin)) {
          scoredBin = bin.index;
          capture = bin.index;
          hits.push("bin-score");
          break;
        }
      }
    }

    if (capture === null) {
      // One bin, chosen before either resolver runs. See `nearestBinTo`.
      const bin = nearestBinTo(ball, bins);
      if (bin) {
        const rim = resolveBinRimContact(ball, bin, flight);
        if (rim) hits.push(rim);
        const wall = resolveBinWallContact(ball, previous, bin, flight);
        if (wall) hits.push(wall);
      }
    } else {
      // A ball a bin already has is inside that bin, and nothing outside it can
      // reach through the wall to touch it.
      const target = bins.find((bin) => bin.index === capture);
      if (target) containCapturedBall(ball, target, dt);
    }

    // The room, through the classic cabinet's own resolvers. A ball that missed
    // every bin bounces and rolls exactly the way it does on the hoop court.
    const ceiling = resolveCeilingContact(ball, flight);
    if (ceiling) hits.push(ceiling);
    const backWall = resolveBackWall(ball, flight);
    if (backWall) hits.push(backWall);
    const floor = resolveFloorContact(ball, dt, flight);
    if (floor) hits.push(floor);

    contacts.push(...hits);
    // A make is swallowed by the bin. Everywhere else, fragile balls keep the
    // catalog's normal rule: wall or floor replaces the ball with a splat.
    const burst = capture === null && hits.find((hit) => ballSplatsOn(ballId, hit));
    if (burst) {
      splat = stickBall(ball, burst);
      break;
    }
  }
  return { contacts, scoredBin, capturedBin: capture, splat };
}

function stickBall(ball, surface) {
  const speed = Math.hypot(ball.vx, ball.vy, ball.vz);
  ball.vx = 0;
  ball.vy = 0;
  ball.vz = 0;
  ball.omegaX = 0;
  ball.splat = { surface, x: ball.x, y: ball.y, z: ball.z, speed };
  return ball.splat;
}

/**
 * The ball, once a bin has it.
 *
 * Held on the bin's axis and pushed down: the shot is over, and what the player
 * is watching from here is a ball dropping into a hole. It keeps stepping only
 * so a turn takes the same time whether the make was clean or a rattle.
 */
function containCapturedBall(ball, bin, dt) {
  const dx = ball.x - bin.x;
  const dz = ball.z - bin.z;
  const radial = Math.hypot(dx, dz);
  const limit = Math.max(0.015, bin.bottomRadius - BALL_RADIUS_WORLD);
  if (radial > limit) {
    const scale = limit / radial;
    ball.x = bin.x + dx * scale;
    ball.z = bin.z + dz * scale;
  }
  const keep = Math.pow(0.035, dt);
  ball.vx *= keep;
  ball.vz *= keep;
  ball.vy = Math.min(ball.vy, -0.45);
}

/**
 * The back wall.
 *
 * The classic cabinet's `resolveBackWallContact` is welded to the backboard, and
 * there is no backboard on this floor — so the bare plaster is resolved here,
 * against the same `WALL_RESTITUTION` the classic room uses, so a ball coming
 * off the wall behaves identically in both modes.
 */
function resolveBackWall(ball, flight) {
  const limit = BOARD_Z - BALL_RADIUS_WORLD;
  if (ball.z <= limit) return null;
  ball.z = limit - SEPARATION;
  ball.vz = -Math.abs(ball.vz) * Math.min(1, WALL_RESTITUTION * (flight.bounce ?? 1));
  return "wall";
}
