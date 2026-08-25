// The hoop: where it is, how it moves, and what the ball has to hit.
//
// Motion is authored in SCREEN space because that is how it reads to the player
// — "left/right" means left and right on the canvas, not along some world axis
// the perspective would skew. `hoopWorldState` is the seam that converts that
// screen path into the world-space position and velocity collisions need.
//
// `hoopAt` is a pure function of elapsed seconds. It deliberately does not read
// a clock: the run feeds it accumulated tick time, so the same run replayed
// tick-for-tick puts the hoop in exactly the same place.

import {
  BACKBOARD_HEIGHT,
  BACKBOARD_RISE,
  BACKBOARD_WIDTH,
  BOARD_Z,
  HOOP_BASE_RIM_Y,
  HOOP_BASE_X,
  RIM_CENTER_Z,
  RIM_SCREEN_HALF_WIDTH,
} from "./constants.js";
import { depthScaleAt, screenToWorldAtZ, screenVelocityToWorld } from "./projection.js";

const TAU = Math.PI * 2;

/**
 * How far the BACKBOARD slides on screen for every pixel the RIM slides.
 *
 * The board is bolted to the wall at `BOARD_Z`; the rim hangs out into the room
 * at `RIM_CENTER_Z`. They are ONE RIGID OBJECT, so when the assembly moves they
 * move by the same distance in WORLD space — which is a smaller distance on
 * screen for the deeper of the two. This ratio is that fact, and nothing else.
 *
 * They used to move by the same number of SCREEN pixels, which is a backboard
 * and a rim travelling at different speeds through the room while bolted
 * together. Two things came of that. The visible one: the assembly slid as a
 * flat cut-out, with no parallax between the board and the ring in front of it.
 * The invisible one was worse — `hoopWorldState` converted that one screen
 * velocity at two depths and handed the collider two different world velocities
 * for the same object, so a ball banked off the board was kicked by a board
 * moving faster than the rim it was welded to.
 *
 * At rest the offsets are zero and every base position below is untouched, so
 * this changes no calibration.
 */
const BOARD_PARALLAX = depthScaleAt(BOARD_Z) / depthScaleAt(RIM_CENTER_Z);

/**
 * The catalog the setup screen, the HUD, and the leaderboard keys are all built
 * from. `id` is persisted (it is half of a board key), so renaming one orphans
 * saved scores — add a mode rather than repurposing an id.
 *
 * `path` returns screen-space offsets from the base position, plus their exact
 * derivatives in pixels/second. The derivative is not decorative: the collision
 * solver resolves the ball against a *moving* ring, and a velocity that
 * disagrees with the path makes the rim behave like it is somewhere else.
 */
export const HOOP_MODES = Object.freeze([
  {
    id: "still",
    label: "Still",
    hudLabel: "STILL",
    blurb: "A fixed rim. Pure shooting form.",
    path: () => ({ dx: 0, dy: 0, vx: 0, vy: 0 }),
  },
  {
    id: "horizontal",
    label: "Left / Right",
    hudLabel: "LEFT / RIGHT",
    blurb: "The rim sweeps across. Lead it.",
    path: (seconds) => {
      const period = 3.6;
      const amplitude = 108;
      const omega = TAU / period;
      const angle = seconds * omega;
      return {
        dx: Math.sin(angle) * amplitude,
        dy: 0,
        vx: Math.cos(angle) * amplitude * omega,
        vy: 0,
      };
    },
  },
  {
    id: "vertical",
    label: "Up / Down",
    hudLabel: "UP / DOWN",
    blurb: "The rim rides up and down. Time the arc.",
    path: (seconds) => {
      const period = 3.2;
      const amplitude = 48;
      const omega = TAU / period;
      const angle = seconds * omega;
      return {
        dx: 0,
        dy: Math.sin(angle) * amplitude,
        vx: 0,
        vy: Math.cos(angle) * amplitude * omega,
      };
    },
  },
  {
    id: "circle",
    label: "Circle",
    hudLabel: "CIRCLE",
    blurb: "The rim orbits. Lead it and time it at once.",
    path: (seconds) => {
      const period = 4.2;
      const amplitudeX = 94;
      const amplitudeY = 40;
      const omega = TAU / period;
      const angle = seconds * omega;
      // Cosine on x and sine on y so the orbit *starts* at the base position
      // rather than off to one side — every run opens from the same rim.
      return {
        dx: (Math.cos(angle) - 1) * amplitudeX,
        dy: Math.sin(angle) * amplitudeY,
        vx: -Math.sin(angle) * amplitudeX * omega,
        vy: Math.cos(angle) * amplitudeY * omega,
      };
    },
  },
  {
    id: "pendulum",
    label: "Pendulum",
    hudLabel: "PENDULUM",
    blurb: "The rim swings on an arc, rising at both ends.",
    path: (seconds) => {
      const period = 3.4;
      const amplitudeX = 104;
      // How far the rim rides UP at the ends of the swing. Screen y grows
      // downward, so the lift is negative.
      const lift = 44;
      const omega = TAU / period;
      const angle = seconds * omega;
      // sin^2 is zero at the centre and one at both extremes, which is exactly a
      // swing: fastest and lowest through the middle, highest where it stalls.
      return {
        dx: Math.sin(angle) * amplitudeX,
        dy: -lift * Math.sin(angle) * Math.sin(angle),
        vx: Math.cos(angle) * amplitudeX * omega,
        vy: -lift * omega * Math.sin(2 * angle),
      };
    },
  },
  {
    id: "figure8",
    label: "Figure 8",
    hudLabel: "FIGURE 8",
    blurb: "A lemniscate. The rim crosses its own path at the centre.",
    path: (seconds) => {
      const period = 5;
      const amplitudeX = 100;
      const amplitudeY = 40;
      const omega = TAU / period;
      const angle = seconds * omega;
      // The 1:2 frequency ratio is what makes a figure 8 rather than an ellipse
      // — one horizontal sweep per two vertical ones.
      return {
        dx: Math.sin(angle) * amplitudeX,
        dy: Math.sin(2 * angle) * amplitudeY,
        vx: Math.cos(angle) * amplitudeX * omega,
        vy: 2 * Math.cos(2 * angle) * amplitudeY * omega,
      };
    },
  },
  {
    id: "cross",
    label: "Cross",
    hudLabel: "CROSS",
    blurb: "A sweep that rotates from side-to-side into up-and-down.",
    path: (seconds) => {
      const period = 3;
      const amplitudeX = 100;
      const amplitudeY = 46;
      const omega = TAU / period;
      const angle = seconds * omega;
      // One sweep, on an axis that itself turns. `raw` runs 1 -> 0 -> 1 at half
      // the sweep rate, handing the travel from the x axis to the y axis and
      // back, so the rim traces a plus over four sweeps. Doing this as a
      // piecewise "now horizontal, now vertical" would put a velocity
      // discontinuity at every corner, and the collision solver resolves the ball
      // against the rim's *reported* velocity — a jump there is a rim that
      // punches the ball for free.
      //
      // The smoothstep matters to how the shape reads: on the raw cosine the
      // handoff is spread over the whole sweep and the rim traces four petals.
      // Squaring the transition up holds each axis while it sweeps and turns only
      // near the middle, so the strokes come out as strokes.
      const raw = (1 + Math.cos(angle / 2)) / 2;
      const blend = raw * raw * (3 - 2 * raw);
      const blendRate = 6 * raw * (1 - raw) * (-(omega / 4) * Math.sin(angle / 2));
      return {
        dx: Math.sin(angle) * amplitudeX * blend,
        dy: Math.sin(angle) * amplitudeY * (1 - blend),
        vx: amplitudeX * (omega * Math.cos(angle) * blend + Math.sin(angle) * blendRate),
        vy: amplitudeY * (omega * Math.cos(angle) * (1 - blend) - Math.sin(angle) * blendRate),
      };
    },
  },
  {
    id: "wander",
    label: "Wander",
    hudLabel: "WANDER",
    blurb: "Two rhythms at once. It never repeats the same lead twice.",
    path: (seconds) => {
      const period = 5.6;
      const amplitudeX = 100;
      const amplitudeY = 44;
      const omega = TAU / period;
      const t = seconds * omega;
      // Deliberately incommensurate frequencies: the pattern is fully
      // deterministic (a replay lands identically) but its period is long enough
      // that a player cannot memorise a lead the way they can on a sine. The
      // weights inside each axis sum to 1, which is what keeps the travel inside
      // the amplitude the mobile crop was checked against.
      return {
        dx: amplitudeX * (0.62 * Math.sin(t) + 0.38 * Math.sin(2.3 * t)),
        dy: amplitudeY * (0.58 * Math.sin(1.7 * t) + 0.42 * Math.sin(0.7 * t)),
        vx: amplitudeX * omega * (0.62 * Math.cos(t) + 0.38 * 2.3 * Math.cos(2.3 * t)),
        vy: amplitudeY * omega * (0.58 * 1.7 * Math.cos(1.7 * t) + 0.42 * 0.7 * Math.cos(0.7 * t)),
      };
    },
  },
]);

/**
 * The screen-space box every mode's rim centre must stay inside.
 *
 * This is not a physics limit — it is the mobile portrait crop. The canvas is
 * drawn at a fixed 960x760 and cropped to width on a phone, so a rim that
 * travels further than this simply leaves the screen on the device most people
 * will play on. `tests/hoop.test.js` holds every mode to it, because the failure
 * is invisible on a desktop browser.
 */
export const HOOP_TRAVEL_BOUNDS = Object.freeze({
  minX: 292,
  maxX: 588,
  minY: 172,
  maxY: 272,
});

export const DEFAULT_HOOP_MODE = "still";

export function hoopModeIds() {
  return HOOP_MODES.map((mode) => mode.id);
}

/** Resolve a mode id, falling back to the default rather than throwing. */
export function hoopModeById(id) {
  return HOOP_MODES.find((mode) => mode.id === id) || HOOP_MODES.find((mode) => mode.id === DEFAULT_HOOP_MODE);
}

/**
 * The complete screen-space hoop at a moment in the run.
 *
 * Everything downstream — rendering, collision, the made-basket test — reads
 * this snapshot rather than recomputing geometry, so there is exactly one
 * definition of where the rim and board are.
 */
export function hoopAt(modeId, elapsedSeconds) {
  const mode = hoopModeById(modeId);
  const seconds = Math.max(0, Number(elapsedSeconds) || 0);
  const { dx, dy, vx, vy } = mode.path(seconds);

  const cx = HOOP_BASE_X + dx;
  const rimY = HOOP_BASE_RIM_Y + dy;
  // The same world displacement, seen at the board's depth instead of the rim's.
  const boardCx = HOOP_BASE_X + dx * BOARD_PARALLAX;
  const boardY = HOOP_BASE_RIM_Y - BACKBOARD_RISE + dy * BOARD_PARALLAX;

  return {
    modeId: mode.id,
    cx,
    rimY,
    left: cx - RIM_SCREEN_HALF_WIDTH,
    right: cx + RIM_SCREEN_HALF_WIDTH,
    boardCx,
    boardW: BACKBOARD_WIDTH,
    boardH: BACKBOARD_HEIGHT,
    boardX: boardCx - BACKBOARD_WIDTH / 2,
    boardY,
    vxScreen: vx,
    vyScreen: vy,
  };
}

/**
 * The hoop as the physics solver sees it: a ring centre on the rim plane, plus
 * the world-space velocity of the assembly.
 *
 * ONE VELOCITY, REPORTED TWICE. The board and the rim are bolted together, so
 * they share a world velocity by definition — the board fields are kept as their
 * own names only because `sim/collision.js` reads them separately, not because
 * they can ever differ. The screen path is authored at the RIM plane (that is
 * the plane the player is aiming at), so that is the plane it is read back on;
 * `BOARD_PARALLAX` is what carries the same motion to the board's depth for
 * drawing.
 */
export function hoopWorldState(hoop) {
  const rim = screenToWorldAtZ(hoop.cx, hoop.rimY, RIM_CENTER_Z);
  const velocity = screenVelocityToWorld(hoop.vxScreen, hoop.vyScreen, RIM_CENTER_Z);

  return {
    rimX: rim.x,
    rimY: rim.y,
    rimZ: RIM_CENTER_Z,
    rimVx: velocity.vx,
    rimVy: velocity.vy,
    boardVx: velocity.vx,
    boardVy: velocity.vy,
  };
}

/** The backboard as an axis-aligned rectangle on the board plane, in world units. */
export function boardWorldBounds(hoop) {
  const topLeft = screenToWorldAtZ(hoop.boardX, hoop.boardY, BOARD_Z);
  const bottomRight = screenToWorldAtZ(hoop.boardX + hoop.boardW, hoop.boardY + hoop.boardH, BOARD_Z);
  return {
    minX: Math.min(topLeft.x, bottomRight.x),
    maxX: Math.max(topLeft.x, bottomRight.x),
    minY: Math.min(topLeft.y, bottomRight.y),
    maxY: Math.max(topLeft.y, bottomRight.y),
  };
}
