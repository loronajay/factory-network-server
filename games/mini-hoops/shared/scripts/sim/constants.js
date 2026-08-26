// Every tuned number the simulation runs on, in one place.
//
// These values are carried over unchanged from the approved prototype. The shot
// feel is the thing players judge this cabinet by, so treat this file as a
// calibration record rather than a set of knobs: changing a value here changes
// how the game plays, and `tests/golden-shot.test.js` exists to make that change
// visible instead of silent.
//
// Two coordinate systems meet in this cabinet and it is worth being explicit:
//
//   WORLD  — the pseudo-3D space the ball actually lives in. `x` runs right,
//            `y` runs up from the floor, `z` runs away from the camera toward
//            the wall. Units are arbitrary but consistent; the ball is
//            BALL_RADIUS_WORLD across and the backboard sits at z = BOARD_Z.
//   SCREEN — canvas pixels in a fixed CANVAS_WIDTH x CANVAS_HEIGHT space.
//
// `sim/projection.js` owns the mapping between them. Nothing else should do that
// arithmetic inline.

// --- Canvas -----------------------------------------------------------------
// The room backdrops are authored at exactly this size, so a backdrop draws 1:1
// with no resampling. Changing these means re-cutting the art.
export const CANVAS_WIDTH = 960;
export const CANVAS_HEIGHT = 760;

// --- Fixed timestep ---------------------------------------------------------
// Repo rule: game logic runs at 60 ticks/s regardless of display refresh rate.
export const TICK_MS = 1000 / 60;
export const TICK_SECONDS = TICK_MS / 1000;

// Each tick is integrated in smaller slices. The ball crosses the rim fast
// enough that a whole 1/60s step can tunnel straight through the ring; this is
// what stops a made basket from being decided by frame phase.
export const PHYSICS_SUBSTEP_SECONDS = 0.008;

// --- Projection -------------------------------------------------------------
// Screen position of the world origin, and how world units scale into pixels.
export const PROJECTION_ORIGIN_X = 480;
export const PROJECTION_X_SCALE = 390;
export const PROJECTION_Y_SCALE = 350;

// THE CAMERA. These three numbers are one pinhole, and they are measured off the
// painted rooms rather than dialled in by eye.
//
// `HORIZON_SCREEN_Y` is eye level: the scanline every floor line and every
// receding edge in the art converges on, and the line a world point at infinite
// depth would land on. `FLOOR_SCREEN_Y` is the floor directly under the player,
// at z = 0. `DEPTH_FALLOFF` says how fast the world shrinks: at z = 1 a world
// unit draws 1/(1 + DEPTH_FALLOFF) as large as it does at the camera plane.
//
// The floor line and the size falloff are NOT independent — see
// `sim/projection.js`, which derives one from the other. They used to be two
// unrelated numbers (the floor line rose linearly with depth while sizes shrank
// hyperbolically), which is a camera that cannot exist: the room's depth read
// as roughly half of what the art was painted for, and a ball against the back
// wall drew nearly a hundred pixels below the painted skirting, out in the
// middle of the floor. That is the bug this block replaced.
export const HORIZON_SCREEN_Y = 298;
export const FLOOR_SCREEN_Y = 726;
export const DEPTH_FALLOFF = 1.0;

// Where the back wall meets the floor, derived rather than declared — it is just
// the floor line at z = 1, and BOARD_Z is 1. Every painted room is aligned to
// this scanline by `assets/room-geometry.js`, so the wall the physics stops the
// ball at is the wall in the picture. Changing the camera above moves the line
// and every room follows it; nothing re-measures the art.
export const WALL_BASE_SCREEN_Y = HORIZON_SCREEN_Y + (FLOOR_SCREEN_Y - HORIZON_SCREEN_Y) / (1 + DEPTH_FALLOFF);

// Where the ceiling meets that same back wall. Measured off the art like the
// rest of the camera, and the one number in this block that is a COMPROMISE
// rather than a reading: the shipped rooms genuinely have different ceiling
// heights (the warehouse's visible wall stops at y=129 under its steel, the
// detention room's runs to y=47), and a room may not change the physics. This
// is close to the middle of them, which puts the bounce within about half a
// ball of the paint in every room instead of matching one and insulting four.
export const WALL_TOP_SCREEN_Y = 78;

// Draw radius of the ball sprite at z = 0, and the floor it never shrinks past.
export const BALL_SCREEN_RADIUS = 29;
export const BALL_MIN_SCREEN_RADIUS = 12.5;

// --- World geometry ---------------------------------------------------------
export const FLOOR_Y = 0;
// The height of the room, derived from the two screen lines above rather than
// dialled in: it is the world distance between the floor and the ceiling where
// they both meet the back wall, which is the one depth the camera measures them
// at exactly. THE ROOM IS CLOSED — before this the ball simply left through the
// ceiling on a full-power heave and came back down through the paint.
export const CEILING_Y = ((WALL_BASE_SCREEN_Y - WALL_TOP_SCREEN_Y) * (1 + DEPTH_FALLOFF)) / PROJECTION_Y_SCALE;
export const GRAVITY = 9.0;
export const BALL_RADIUS_WORLD = 0.078;
export const BOARD_Z = 1.0;
export const RIM_CENTER_Z = 0.75;
export const RIM_RADIUS_WORLD = 0.22;
export const RIM_TUBE_RADIUS = 0.026;

// --- Restitution ------------------------------------------------------------
export const RIM_RESTITUTION = 0.62;
export const BOARD_RESTITUTION = 0.68;
export const WALL_RESTITUTION = 0.3;
// Plaster overhead. Deader than the wall, because a ball that came off the
// ceiling with any life in it would turn a wild heave into a second free route
// through the hoop, and the cabinet already has exactly one lucky shot.
export const CEILING_RESTITUTION = 0.26;
export const FLOOR_RESTITUTION = 0.43;
// How much tangential speed the rim scrubs off on contact. Low, but non-zero is
// what makes a rattle settle instead of pinballing forever.
export const RIM_FRICTION = 0.07;

// --- Hoop screen geometry ---------------------------------------------------
// The rest position the motion modes oscillate around.
export const HOOP_BASE_X = 480;
export const HOOP_BASE_RIM_Y = 222;
export const RIM_SCREEN_HALF_WIDTH = 42;
// There is deliberately no RIM_DRAW_RADIUS here any more. The rim's drawn
// ellipse is not a constant — it depends on how far the rim is from eye level,
// which every motion mode changes — so it is projected from RIM_RADIUS_WORLD by
// `sim/projection.js`'s `ringEllipseAt` instead. The pair that used to live here
// (48 x 12) was right about the width by luck and wrong about the height at
// every rim position except one.
export const BACKBOARD_WIDTH = 154;
export const BACKBOARD_HEIGHT = 98;
// Vertical gap from the rim up to the top edge of the backboard.
export const BACKBOARD_RISE = 104;

// --- Pull gesture -----------------------------------------------------------
// Pull distance in screen pixels. Below PULL_MIN the gesture is treated as a
// tap and nothing is fired; PULL_MAX is 100% power.
export const PULL_MIN = 10;
export const PULL_MAX = 105;
// The ball visually follows most, not all, of the finger travel. The remaining
// stretch is drawn as an elastic segment so the pull reads as tension rather
// than as the ball lagging behind the finger.
export const PULL_VISUAL_GAIN = 0.68;
// How far sideways the aim marker swings for a fully angled pull. This, times
// PULL_ANGLE_RATIO_LIMIT, IS the reticle's reach either side of centre — see
// AIM_MIN_X below, which is derived from it rather than typed beside it.
//
// It is set so that reach is 188px, which is not a taste number: the rim's own
// travel is `HOOP_TRAVEL_BOUNDS` x 292..588, and 480-292 is 188. THE RETICLE HAS
// TO REACH EVERY POSITION THE RIM CAN OCCUPY. At the old 156 it reached only
// 355..605, so the leftmost stretch of every horizontal mode's sweep could not
// be aimed at directly at all — you could only ever lead the rim back toward the
// middle, never meet it out at the end of its travel. Not derived from
// HOOP_TRAVEL_BOUNDS in code because hoop.js reads this file and not the other
// way round; `tests/pull.test.js` asserts the relationship instead.
export const PULL_AIM_GAIN = 235;
// Lateral travel is allowed but clamped against backward travel, so the gesture
// always still reads as a pull *back* toward the player.
export const PULL_SIDE_LIMIT = 0.9;
// Even a pull with no backward travel allows a little sideways play, so the
// gesture does not lock up the instant a finger moves horizontally first.
export const PULL_MIN_SIDE = 9;
// Aim angle is read as sideways-over-backward. The floor on the backward term
// stops a barely-started pull from swinging the aim to full lock.
export const PULL_ANGLE_MIN_BACK = 42;
export const PULL_ANGLE_RATIO_LIMIT = 0.8;
// The aim marker cannot leave this horizontal band, and the band is DERIVED
// from the gesture that swings it rather than stated alongside. They used to be
// two independent numbers and they disagreed: the clamp declared 320..640 while
// a fully angled pull only ever reached 355..605, so a quarter of the declared
// band was unreachable — and HORSE reads this band as the statement of what a
// player can aim at, so it was licensing bin placements no pull could convert.
// One statement now, and widening the gesture widens both together.
export const AIM_REACH_X = PULL_AIM_GAIN * PULL_ANGLE_RATIO_LIMIT;
export const AIM_MIN_X = HOOP_BASE_X - AIM_REACH_X;
export const AIM_MAX_X = HOOP_BASE_X + AIM_REACH_X;
// Aim sits marginally below the rim line so a dead-centre shot descends into the
// ring rather than grazing its front edge.
export const AIM_RIM_Y_OFFSET = 2;

// --- Arc / loft -------------------------------------------------------------
// A straight backward pull gives the steepest arc; a lateral pull flattens it.
export const MIN_EXIT_VY = -1.15;
export const MAX_EXIT_VY = -2.05;
// The vertical-ness of the pull is remapped through this window into loft 0..1.
// Below LOFT_RATIO_FLOOR the pull counts as fully flat.
export const LOFT_RATIO_FLOOR = 0.72;
export const LOFT_RATIO_SPAN = 0.28;
// The pull length that counts as the calibrated reference shot. Velocity scales
// linearly against it, which is what makes the displayed power percentage honest.
export const REFERENCE_POWER = 0.8;

// A target at or below the launch point has no ballistic solution. This floor
// keeps the solver defined for a shot aimed absurdly low.
export const LAUNCH_MIN_RISE = 0.08;
// Guard on the depth term when estimating how long the ball takes to reach the
// rim plane, so a shot with almost no forward speed cannot divide by zero.
export const LAUNCH_MIN_DEPTH_SPEED = 0.01;

// --- Spin -------------------------------------------------------------------
// Backspin imparted at launch, as a fraction of the ball's forward roll rate.
export const LAUNCH_SPIN_BASE = 0.68;
export const LAUNCH_SPIN_PER_LOFT = 0.18;
export const SPIN_DECAY_PER_TICK = 0.9985;

// --- Shot resolution --------------------------------------------------------
// A shot is abandoned once it is clearly dead, so a timed run is never held
// hostage by a ball rolling around the floor.
export const SHOT_SETTLE_SECONDS = 0.48;
export const SHOT_MAX_SECONDS = 2.45;
// Two contacts closer together than this are one collision, not two, and only
// announce themselves once.
export const CONTACT_DEBOUNCE_SECONDS = 0.08;

// A ball that never got near the wall was thrown short, rather than simply
// missing — worth saying differently, because the fix is different.
export const SHORT_DEPTH_THRESHOLD = 0.48;
// A contacted ball heading back into the room below rim height can no longer
// recover into a score. These bounds decide when to call it, and they are
// deliberately generous so a bank or a rattle-in is never cut off early.
export const ABORT_DEPTH_SPEED = -0.08;
export const ABORT_DEPTH_MARGIN = 0.3;
export const ABORT_HEIGHT_MARGIN = 0.1;
// Past this depth the ball is behind the camera and out of play.
export const OUT_OF_PLAY_Z = -0.28;

// --- Scoring ----------------------------------------------------------------
export const POINTS_PER_BASKET = 2;
export const ON_FIRE_STREAK = 3;

// --- Round ------------------------------------------------------------------
export const ROUND_DURATIONS = Object.freeze([30, 60]);
export const DEFAULT_DURATION = 30;
export const LEADERBOARD_SIZE = 5;
