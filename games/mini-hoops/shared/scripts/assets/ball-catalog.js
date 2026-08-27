// The registry of throwable balls.
//
// Adding a ball should be a data change, never a code change: drop its frames in
// `assets/balls/<id>/roll-NN.png`, add a row here, and the setup screen, the
// preloader, the renderer and the roll animation all pick it up. Nothing outside
// this file may assume how many frames a ball has — the basketball has 12 and the
// paper wad has 8, and a future ball will have some third number.
//
// FRAME COUNT IS LOAD-BEARING, not decoration. The renderer does not tick an
// animation timer; it derives the frame from the ball's real angular position, so
// one full 2*PI rotation advances exactly `frameCount` frames. Declare the wrong
// count and the ball visibly slips against its own roll.
//
// BALLS FLY DIFFERENTLY, and that is the point of choosing one. Each row below
// carries a `flight` block: how heavy it is, how much the air holds it back, how
// lively it comes off the rim, and how much that rim grabs it. A paper wad
// floats and dies where it lands; a snowball drops like a stone.
//
// This REPLACES the cabinet's original balls-are-cosmetic rule, deliberately and
// with the owner's call. The old rule existed to protect a board keyed on
// `mode:duration` alone: if a ball changed the shot, two entries on one board
// were no longer the same achievement. The answer here is not to split the
// boards — it is to SHOW THE BALL. A board still ranks every ball together, and
// every row names the ball the run was set with, so the reader can weigh it.
// `store/boards.js` already carries `ballId` on every entry for exactly this.
//
// The consequence to keep in mind: `basketball` is the reference ball and every
// number in `sim/constants.js` is calibrated against it. A flight block is
// expressed as a MULTIPLIER on that reference, so the basketball's block is all
// ones and reads as documentation of what "normal" means.
//
// The snowball and the meatball also SPLAT. See SPLAT_SURFACES below: they burst
// on bare wall and floor, the two surfaces a shot is already dead on, so
// bursting never turns a miss into a make or a make into a miss. That is still worth keeping — not to
// protect board parity any more, but because a ball that vanished off the rim
// would lose rattle-ins and bank-ins, which are outcomes the player earned.

/** Where a ball's frames live, relative to the cabinet root. */
const BALL_ASSET_ROOT = "assets/balls";

/** Authored size of every roll frame and splat decal, in pixels. `tools/resize-ball-frames.mjs` enforces it. */
export const BALL_FRAME_SIZE = 512;

/**
 * The surfaces a splatting ball is destroyed by.
 *
 * DELIBERATELY GLOBAL, and deliberately short. Bare wall and floor are the two
 * contacts a shot is ALREADY dead on — `sim/shot.js` calls the miss the instant
 * either happens, because there is no route back through the hoop from either
 * one. The rim and the backboard are pointedly absent, and stay absent even now
 * that balls fly differently: a ball that burst on the rim would lose every
 * rattle-in and one that burst on the board would lose the bank-in, and those
 * are outcomes the player earned rather than flavour.
 *
 * A ball's CHARACTER belongs in its `flight` block, which is a per-ball knob.
 * Which surfaces destroy it is not. See CLAUDE.md.
 */
export const SPLAT_SURFACES = Object.freeze(["wall", "floor"]);

/**
 * The reference flight. Every field is a MULTIPLIER on the calibrated numbers in
 * `sim/constants.js`, so this object is what "plays like the house basketball"
 * means, spelled out.
 *
 *   weight  scales GRAVITY. The launch solver is told about it, so a ball that
 *           falls faster still swishes at the reference pull — what changes is
 *           the SHAPE and TEMPO of the arc. A light ball floats up and hangs; a
 *           heavy one is flat and quick. This is the knob that is compensated.
 *   drag    air resistance, as a per-second exponential decay on velocity. The
 *           solver is NOT told about it, deliberately: this is the knob that
 *           makes a ball genuinely harder, because it lands short of the reticle
 *           at the reference pull and the player has to find the new number.
 *   bounce  scales every restitution — rim, backboard, wall, floor. Low is dead:
 *           it drops where it hits instead of finding a friendly second chance.
 *   grip    scales RIM_FRICTION. High grip scrubs more speed off a graze, which
 *           turns rattles that would have kicked out into rattles that drop in.
 */
export const REFERENCE_FLIGHT = Object.freeze({ weight: 1, drag: 0, bounce: 1, grip: 1 });

/**
 * The ends of each stat's bar, for display only.
 *
 * These do NOT clamp anything the sim does — they are the scale the setup screen
 * draws against, so a new ball outside them would simply peg its bar. Widen them
 * here rather than teaching the view about numbers.
 */
const FLIGHT_DISPLAY_RANGE = Object.freeze({
  weight: Object.freeze({ min: 0.6, max: 1.5 }),
  drag: Object.freeze({ min: 0, max: 0.4 }),
  bounce: Object.freeze({ min: 0.2, max: 1.1 }),
  grip: Object.freeze({ min: 0.9, max: 2 }),
});

/**
 * What each stat is called on screen, and which direction is "more".
 *
 * `hint` says what the number does to the shot in the player's terms, because
 * "Grip 1.85" tells nobody anything. Kept beside the range rather than in the
 * view so the whole readout is one data change per stat.
 */
const FLIGHT_DISPLAY = Object.freeze([
  Object.freeze({ key: "weight", label: "Weight", hint: "Heavier falls faster and flattens the arc" }),
  Object.freeze({ key: "drag", label: "Air Drag", hint: "More drag lands the ball short — pull harder" }),
  Object.freeze({ key: "bounce", label: "Bounce", hint: "Livelier off the rim, the board and the floor" }),
  Object.freeze({ key: "grip", label: "Rim Grip", hint: "More grip kills a rattle so it drops in" }),
]);

export const BALLS = Object.freeze([
  Object.freeze({
    id: "basketball",
    label: "Basketball",
    blurb: "The house ball. Twelve frames of honest orange leather.",
    frameCount: 12,
    // The reference. Every other ball's numbers mean "compared to this one",
    // and every constant in `sim/constants.js` was tuned with this in the air.
    flight: REFERENCE_FLIGHT,
  }),
  Object.freeze({
    id: "paper",
    label: "Paper Wad",
    blurb: "Yesterday's memo, balled up and ready for the bin.",
    frameCount: 8,
    // Floats up on a lazy arc and the air eats it, so it lands short of where
    // the reticle promised and has to be thrown well past the reference pull.
    // What it gives back: it barely bounces, and it grabs the rim hard enough
    // that a rattle tends to die in the ring rather than kick out.
    flight: Object.freeze({ weight: 0.78, drag: 0.34, bounce: 0.45, grip: 1.85 }),
  }),
  Object.freeze({
    id: "bowling-ball",
    label: "Bowling Ball",
    blurb: "Sixteen pounds of resin. The hoop was not consulted.",
    frameCount: 8,
    // The heavy end of the roster: it drops fast and flat, and almost nothing
    // in the air touches it, so it goes exactly where it is thrown. The price
    // is that it is dead on contact — the deadest bounce of any ball — so it
    // has no second chances at all. Either the shot was right or it was not.
    flight: Object.freeze({ weight: 1.45, drag: 0.02, bounce: 0.38, grip: 1.6 }),
  }),
  Object.freeze({
    id: "snowball",
    label: "Snowball",
    blurb: "Packed hard, indoors, against all advice.",
    frameCount: 8,
    // Dense and clean through the air, so it dives on a shorter arc than the
    // basketball with only a little drag to read. It still bursts on wall and
    // floor, which costs it nothing that was ever going in.
    flight: Object.freeze({ weight: 1.22, drag: 0.08, bounce: 0.8, grip: 1.35 }),
    // A ball that does not survive its own landing. Presence of this block is
    // what makes it splat; the fields are only how the splat LOOKS. Which
    // surfaces end it is SPLAT_SURFACES above, and is not negotiable per ball.
    splat: Object.freeze({
      // Thrown-off powder at the moment of impact.
      color: "#eef5ff",
      // How wide the decal sits, in ball diameters — before the projection
      // shrinks it for depth, which it does the same way it shrinks the ball.
      scale: 2.7,
    }),
  }),
  Object.freeze({
    id: "meatball",
    label: "Meatball",
    blurb: "Made with love, deliciously juicy.",
    frameCount: 4,
    // Heavier and draggier than the snowball, which is the second bursting ball
    // it is most easily mistaken for: it dives on the shortest arc of anything
    // that splats, and it lands enough short of the reticle to be worth
    // re-learning the meter for. What it keeps is grip — a wet ball dies in the
    // ring rather than kicking out, which is where its makes come from.
    flight: Object.freeze({ weight: 1.33, drag: 0.11, bounce: 0.8, grip: 1.35 }),
    // A ball that does not survive its own landing. Presence of this block is
    // what makes it splat; the fields are only how the splat LOOKS. Which
    // surfaces end it is SPLAT_SURFACES above, and is not negotiable per ball.
    splat: Object.freeze({
      // Sauce, not powder — and DELIBERATELY NOT THE SNOWBALL'S. The tint is
      // read off the decal art's own mean (183, 52, 27) and lifted a little,
      // the same way the snowball's spray is lighter than its decal, so the
      // grains in the air read against a dark room. Two bursting balls that
      // threw the same white would be one effect wearing two hats.
      color: "#cf3a22",
      // How wide the decal sits, in ball diameters — before the projection
      // shrinks it for depth, which it does the same way it shrinks the ball.
      scale: 2.7,
    }),
  }),
  Object.freeze({
    id: "rubber-band-ball",
    label: "Rubber Band Ball",
    blurb: "Someone had a lot of time on their hands.",
    frameCount: 4,
    // The LIVE end of the roster, and the only ball whose bounce is authored
    // past the display range on purpose. Restitution is capped at 1 in
    // `sim/collision.js`, so 2.15 does not mean "comes back faster than it
    // arrived" — it means every surface in the room is pinned at or near its
    // own ceiling, and the bar simply pegs. A rattle that would kick any other
    // ball out flings this one around the ring until the grip finally kills it,
    // so its makes come from second and third chances rather than from the
    // first pass. Slightly heavy and very clean through the air, so the ARC is
    // honest and close to the reference; it is only the CONTACT that is chaos.
    flight: Object.freeze({ weight: 1.11, drag: 0.01, bounce: 2.15, grip: 1.9 }),
  }),
  Object.freeze({
    id: "magma-ball",
    label: "Magma Ball",
    blurb: "Still cooling. Best not to hold it for long.",
    frameCount: 4,
    // Light and clean: it climbs on the floatiest arc in the roster and the air
    // barely touches it, so the reticle stays close to honest. What it pays is
    // everything on contact — the deadest ball in the cabinet, deader than the
    // bowling ball, because molten rock does not bounce. It drops where it hits
    // and stays there. The grip is what keeps it playable: a rattle sticks in
    // the ring and drips through instead of kicking out, which is where its
    // makes come from now that the rim has stopped handing it second chances.
    flight: Object.freeze({ weight: 0.82, drag: 0.03, bounce: 0.2, grip: 1.7 }),
    // The only ball that BURNS. Presence of this block is what gives a ball a
    // flame trail in flight and a fire where it lands; the fields are only how
    // those look. Cosmetic by construction in the same way `splat` is — see
    // `effects/flame-trail.js`, which is a fourth-layer effect and can no more
    // reach the score than a splat decal can. What makes this ball harder is
    // its `flight` block above, which is published on the setup picker; the
    // fire is not, and must never become an advantage.
    trail: Object.freeze({
      // Hottest at the centre of a grain, cooling outward, and grey by the time
      // it has fallen behind. Three stops rather than one tint, because a trail
      // painted in a single colour reads as a ribbon rather than as fire.
      core: "#fff0bd",
      flame: "#ff6a12",
      smoke: "#6b4534",
      // Grains per second at full speed, and how long one lives. The rate is
      // scaled by how fast the ball is actually moving — a ball sitting on the
      // floor smoulders, one crossing the room streams.
      rate: 120,
      life: 0.52,
      // Grain radius in world units, before the projection shrinks it for depth
      // exactly the way it shrinks the ball and the splat decals.
      size: 0.05,
      // What it leaves burning where it lands. `radius` is the patch on the
      // surface; `rate` is how hard that patch goes on throwing grains.
      fire: Object.freeze({ life: 2.4, rate: 30, radius: 0.26 }),
    }),
  }),
  Object.freeze({
    id: "beach-ball",
    label: "Beach Ball",
    blurb: "Mostly air. It has opinions about where it is going.",
    frameCount: 3,
    // The magma ball's opposite trade, and the roster's other extreme. It is
    // the LIGHTEST thing here and the draggiest, so it floats up forever and
    // then dies in the air — the reference pull lands it well short of the
    // reticle and finding its own number is the whole of learning it. What it
    // gives back is a lively bounce; what it takes is the only grip in the
    // cabinet BELOW the basketball's, because a slick vinyl skin does not hold
    // a steel ring. A rattle kicks out. The magma ball is dead on contact and
    // sticks; this one is alive on contact and slides.
    flight: Object.freeze({ weight: 0.35, drag: 0.15, bounce: 1.05, grip: 0.95 }),
  }),
]);

export const DEFAULT_BALL = "basketball";

export function ballIds() {
  return BALLS.map((ball) => ball.id);
}

/** Resolve a ball id, falling back to the default rather than throwing. */
export function ballById(id) {
  return BALLS.find((ball) => ball.id === id) || BALLS.find((ball) => ball.id === DEFAULT_BALL);
}

/** The frame filenames for a ball, in roll order. */
export function ballFramePaths(id) {
  const ball = ballById(id);
  return Array.from(
    { length: ball.frameCount },
    (_, index) => `${BALL_ASSET_ROOT}/${ball.id}/roll-${String(index).padStart(2, "0")}.png`,
  );
}

/**
 * One frame of a ball, for showing the thing itself in a picker.
 *
 * Every picker in the cabinet used to name a ball and draw nothing, which asks a
 * player to recognise "Rubber Band Ball" as a colour they have never seen. There
 * is no separate portrait art and there should not be: the roll frames ARE the
 * ball, photographed square on a transparent background at `BALL_FRAME_SIZE`, so
 * a portrait is frame zero and adding a ball still costs exactly one folder.
 */
export function ballPortraitPath(id) {
  return ballFramePaths(id)[0];
}

/**
 * Which frame to draw for a given roll phase.
 *
 * `rollPhase` is a continuous frame position accumulated from angular velocity,
 * so it is fractional and it goes negative whenever the ball rolls backward —
 * a plain `%` would return a negative index for exactly that case.
 */
export function ballFrameIndex(id, rollPhase) {
  const { frameCount } = ballById(id);
  if (!Number.isFinite(rollPhase)) return 0;
  const index = Math.floor(rollPhase) % frameCount;
  return index < 0 ? index + frameCount : index;
}

/**
 * The splat cosmetics for a ball, or null if it survives its landings.
 *
 * Callers test this for truthiness to know whether a ball splats at all, so it
 * returns null rather than an empty object — "this ball is fragile" and "this
 * ball is fragile in no particular way" are not the same statement.
 */
export function ballSplat(id) {
  return ballById(id).splat || null;
}

/**
 * The flame cosmetics for a ball, or null if it does not burn.
 *
 * Same convention as `ballSplat`: null rather than an empty object, because
 * "this ball is on fire" and "this ball is on fire in no particular way" are
 * not the same statement, and every composition root tests it for truthiness to
 * know whether to run a trail at all.
 */
export function ballTrail(id) {
  return ballById(id).trail || null;
}

/** Whether this ball is destroyed by a contact with `surface`. */
export function ballSplatsOn(id, surface) {
  return Boolean(ballById(id).splat) && SPLAT_SURFACES.includes(surface);
}

/**
 * The two decals a splatting ball leaves behind, or null.
 *
 * Same convention as the roll frames: art at a known path under the ball's own
 * folder, so adding a fragile ball stays a data change.
 */
export function ballSplatPaths(id) {
  const ball = ballById(id);
  if (!ball.splat) return null;
  return Object.freeze({
    wall: `${BALL_ASSET_ROOT}/${ball.id}/splat-wall.png`,
    ground: `${BALL_ASSET_ROOT}/${ball.id}/splat-ground.png`,
  });
}

/**
 * How much roll phase one radian of rotation is worth for this ball.
 *
 * This is the whole reason frame count cannot be a global: the physics reports
 * radians, and each ball converts them into its own frame space.
 */
export function rollPhasePerRadian(id) {
  return ballById(id).frameCount / (Math.PI * 2);
}

/**
 * How this ball flies, as multipliers on the reference.
 *
 * Always returns a complete block: a row may declare only the fields it changes
 * and the rest fall back to the reference, so adding a fifth knob later does not
 * mean editing every existing row. The sim treats this as required data — see
 * `sim/physics.js` and `sim/launch.js`.
 */
export function ballFlight(id) {
  return Object.freeze({ ...REFERENCE_FLIGHT, ...(ballById(id).flight || null) });
}

/**
 * The ball's flight, shaped for display.
 *
 * Returns one row per stat: the raw multiplier, a 0..1 `fill` for a bar, and the
 * human sentence. The view does no arithmetic on flight numbers — if a bar looks
 * wrong the fix is FLIGHT_DISPLAY_RANGE above, not the renderer.
 *
 * `fill` is clamped so a ball authored outside the display range pegs its bar
 * instead of drawing past the end of it.
 */
export function ballFlightStats(id) {
  const flight = ballFlight(id);
  return FLIGHT_DISPLAY.map(({ key, label, hint }) => {
    const { min, max } = FLIGHT_DISPLAY_RANGE[key];
    const span = max - min;
    const fill = span > 0 ? (flight[key] - min) / span : 0;
    return {
      key,
      label,
      hint,
      value: flight[key],
      // Relative to the house ball, which is the comparison a player actually
      // makes. 1 means "same as the basketball" for every stat.
      relative: flight[key] / (REFERENCE_FLIGHT[key] || 1),
      fill: Math.max(0, Math.min(1, fill)),
    };
  });
}
