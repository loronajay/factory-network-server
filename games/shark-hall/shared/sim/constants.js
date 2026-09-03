// Every number the table is made of, in one place.
//
// Metres and seconds throughout. The table is a 9-foot bar box scaled to the
// demo's units: 2.54m of playing surface by 1.27m, and a 57.15mm ball, which is
// the real-world pair. Keeping them real is what makes the friction and
// restitution numbers below mean anything — they were tuned against a ball of
// this mass rolling on a cloth of this size, and rescaling the table without
// rescaling them changes how the game plays.
//
// THIS FILE IS PURE. No THREE, no DOM. Everything under `sim/` obeys that rule
// so the whole physics and rules layer runs under node, and so a future
// server-authoritative mode has something it can actually mirror.

// --- geometry --------------------------------------------------------------

/** Playing surface, rail to rail. */
export const TABLE_LENGTH = 2.54;
export const TABLE_WIDTH = 1.27;

/** Half-extents, used far more often than the full ones. */
export const HALF_LENGTH = TABLE_LENGTH / 2;
export const HALF_WIDTH = TABLE_WIDTH / 2;

/** Ball radius. A regulation 57.15mm ball. */
export const BALL_RADIUS = 0.028575;

/**
 * Pocket mouth half-widths, measured along the cushion they interrupt.
 *
 * These are not decoration: they are the gaps the cushion segments stop short
 * of, the centres the rounded jaws are placed at, and the tolerance
 * `pockets.js` uses to decide a ball crossed a mouth rather than struck a rail.
 * All four consumers read the same two numbers, which is the only way a ball
 * cannot fall through a gap the renderer did not draw.
 */
export const CORNER_GAP = 0.112;
export const SIDE_GAP = 0.072;

/** Capture radius at the centre of each pocket. Corners swallow a little more than sides. */
export const CORNER_POCKET_RADIUS = 0.078;
export const SIDE_POCKET_RADIUS = 0.071;

/**
 * The head string, at a quarter of the table's length from the head rail.
 *
 * House 8-ball: a scratch is cue ball in hand BEHIND this line, and the break is
 * taken from behind it too. `placement.js` is the only file that enforces it.
 */
export const HEAD_STRING_X = -HALF_LENGTH / 2;

/** Where the cue ball is spotted for a break, and the apex of the rack. */
export const BREAK_CUE_X = -0.72;
export const RACK_APEX_X = 0.52;

// --- physics ---------------------------------------------------------------

export const BALL_MASS = 0.17;
/** Solid sphere: I = 2/5 m r². Written out so a changed radius carries through. */
export const BALL_INERTIA = 0.4 * BALL_MASS * BALL_RADIUS * BALL_RADIUS;
export const GRAVITY = 9.81;

/**
 * Two friction coefficients, because a struck ball does two different things.
 *
 * SLIDE_MU applies while the contact patch is still skidding across the cloth,
 * and it is what converts the cue's spin into follow and draw — it is a real
 * torque on the ball, not a fudge on its velocity. ROLL_MU applies once the ball
 * has picked up natural roll and is the slow bleed that eventually stops it.
 * Sliding friction is an order of magnitude larger, which is why draw dies
 * within a diamond or two and a rolling ball crosses the table.
 */
export const SLIDE_FRICTION = 0.19;
export const ROLL_FRICTION = 0.012;

/** Spin about the vertical axis (English) decays on its own; nothing else removes it. */
export const SPIN_DECAY = 0.72;

export const BALL_RESTITUTION = 0.94;

/**
 * Cushion restitution, which is NOT a constant on a real table.
 *
 * Rubber gets less elastic the harder it is hit: a measured cushion returns
 * around 0.86 of a slow ball's speed and only about 0.67 of a break-speed one.
 * A flat number has to pick one of those, and 0.84 picked the slow end, which is
 * what made a hard shot ricochet around the table for six seconds like a
 * pinball. `cushionRestitution` in `physics.js` reads these three.
 *
 * LOW is the value approached as the impact speed goes to zero, FALLOFF is how
 * much is lost per m/s of closing speed, and MIN is the floor a break cannot
 * push it below.
 */
export const CUSHION_RESTITUTION_LOW = 0.88;
export const CUSHION_RESTITUTION_FALLOFF = 0.038;
export const CUSHION_RESTITUTION_MIN = 0.66;

/** Tangential friction caps, as a fraction of the normal impulse (Coulomb). */
export const BALL_FRICTION = 0.045;

/**
 * Cushion tangential friction — deliberately far below the rubber's real mu.
 *
 * This is a FIT, not a material constant, and the reason is the model. The
 * contact here is at the ball's equator, so a ball's forward roll contributes
 * nothing to the horizontal slip along the rail and the along-rail component
 * reads as a pure skid. Charge Coulomb friction at the rubber's actual mu
 * against that and the rail scrubs the tangential component almost to a stop:
 * at 0.16 a ball arriving 45 degrees off the normal left at 40, where a real
 * cushion sends it out at about 50. A real cushion strikes ABOVE centre and the
 * ball climbs out of the rubber rather than rolling sideways along it, which is
 * why the observed rebound is LONGER than the incidence rather than shorter.
 *
 * 0.055 reproduces the measured angles (`tests/physics.test.js` asserts them)
 * while leaving enough bite for running English to lengthen the angle and add
 * speed. Raise it and every rail shortens; drop it to zero and English stops
 * coming off the cushion at all.
 */
export const CUSHION_FRICTION = 0.055;

/** Radius of the rounded pocket facings the jaws are modelled with. */
export const JAW_RADIUS = 0.02;

// --- motion thresholds -----------------------------------------------------

/** Below this speed a ball is treated as stopped, for settling the shot. */
export const REST_SPEED = 0.006;
/** Below this the integrator zeroes the velocity outright, to stop it creeping. */
export const SNAP_SPEED = 0.0045;
/** Slip below this counts as natural roll rather than a skid. */
export const ROLL_SLIP = 0.015;

/** A ball this slow hanging over a pocket lip is taken by it rather than left balanced. */
export const HANGING_SPEED = 0.055;

/** The fixed physics timestep. 240hz, so a hard break resolves cleanly. */
export const SIM_STEP = 1 / 240;

/**
 * How long every ball must be still before the shot is scored.
 *
 * Not cosmetic. A ball balanced on a pocket lip can sit motionless for a third
 * of a second and then drop, and scoring the instant motion stopped would credit
 * the shot to the wrong player. The wait is what makes `captureHangingBalls`
 * meaningful.
 */
export const SETTLE_MS = 720;

// --- the shot --------------------------------------------------------------

/** Cue-ball speed at zero and full power, in m/s. */
export const MIN_SHOT_SPEED = 0.38;
export const MAX_SHOT_SPEED = 5.43;

/** How long the shot button must be held to reach full power. */
export const FULL_CHARGE_MS = 1550;
