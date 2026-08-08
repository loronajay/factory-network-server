// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/sim/constants.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

// Tuning tables and unit constants. Data only — no behaviour lives here, so
// balancing passes never have to touch logic files.

export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;
export const TICK_SECONDS = 1 / TICK_HZ;

export const MPS_TO_MPH = 2.2369362920544;
export const RAD_PER_SEC_TO_RPM = 60 / (2 * Math.PI);

/** Race distances in metres, keyed by the id the mode selector uses. */
export const RACE_DISTANCES = {
  eighth: { id: "eighth", label: "1/8 Mile", metres: 201.168 },
  quarter: { id: "quarter", label: "1/4 Mile", metres: 402.336 },
  half: { id: "half", label: "1/2 Mile", metres: 804.672 },
  mile: { id: "mile", label: "1 Mile", metres: 1609.344 },
};

export const DEFAULT_DISTANCE_ID = "quarter";

/**
 * The Milestone 1 car. Every field is a real drivetrain quantity so the physics
 * stay dimensionally honest and later cars differ by data alone.
 */
export const DEFAULT_CAR = {
  id: "demon",
  name: "Speed Demon",

  mass: 1450, // kg
  wheelRadius: 0.32, // m
  driveEfficiency: 0.92,

  idleRpm: 900,
  peakTorqueRpm: 4800,
  peakTorqueNm: 420,
  redlineRpm: 7200,
  limiterRpm: 7600, // hard fuel cut above this

  // Progressive ratios: big steps low, closing up high. Tuned together with the
  // torque curve below so the power crossover between consecutive gears lands
  // below the redline in every gear — see `optimalShiftRpm`.
  gearRatios: { 1: 3.4, 2: 2.36, 3: 1.76, 4: 1.38, 5: 1.11, 6: 0.92 },
  finalDrive: 3.9,

  // Torque falls away either side of the peak. The falloff is asymmetric because
  // real engines drop off harder past peak than they climb to it — and because a
  // symmetric curve makes the correct strategy "hold every gear to the limiter",
  // which would delete the timing skill this game is built on.
  torqueFalloffBelow: 0.55,
  torqueFalloffAbove: 0.9,
  minTorqueFactor: 0.15,

  // Caps drive force so first gear cannot produce an absurd launch. Stands in
  // for a tyre model until one is worth building. Headroom above the drive force
  // of the lower gears is deliberate: without it a perfect-shift bonus would be
  // clipped away by the cap and the player would never feel the reward.
  maxTractionForce: 12500, // N

  // How fast the needle falls when the clutch is in and the engine is free.
  rpmDecayPerSecond: 4200,
  // ...and how fast it climbs if you are still on the gas with the clutch in.
  // Nothing here reaches the road: this is the flare that makes "you never
  // lifted" visible on the tachometer instead of being an invisible rule.
  rpmRisePerSecond: 5200,

  dragK: 0.42, // N per (m/s)^2
  rollK: 12, // N per (m/s)

  /**
   * Where this engine wants to be shifted. Not a guess: this is where the next
   * gear's wheel force overtakes the current gear's after the rev drop, measured
   * across the ratio set. Per-gear crossovers run 7076 -> 6610 rpm, so a single
   * shift point is honest to within a couple of hundred rpm, and it sits below
   * the 7200 redline — holding to the limiter is a real loss, not a shortcut.
   */
  optimalShiftRpm: 6850,
};

/**
 * RPM windows around the car's optimal shift point. Derived from measured lap
 * cost rather than picked by feel:
 *
 *   +/- 175 rpm  costs under 0.01s   -> perfect
 *   +/- 450 rpm  costs up to ~0.38s  -> good
 *   beyond       costs 0.4s and up   -> poor
 *
 * The windows are symmetric but the consequences are not: over-revving crosses
 * the power crossover and hurts far more than shifting early by the same margin.
 * That asymmetry comes out of the physics, so grading does not restate it.
 */
export const PERFECT_RPM_WINDOW = 175;
export const GOOD_RPM_WINDOW = 450;

/**
 * Gate execution speed. A shift completed inside `SNAP` is rewarded with extra
 * drive force; one that drags past `SLOW` costs a full grade. Between the two is
 * neutral — competent, unremarkable.
 */
export const SHIFT_SNAP_SECONDS = 0.4;
export const SHIFT_SLOW_SECONDS = 0.75;
export const SNAP_FORCE_BONUS = 0.06;

/**
 * The throttle's half of a shift, measured against the moment the clutch bites.
 *
 * A shift is three inputs, not one: lift off the gas, work the gate, then pick
 * the gas back up as the clutch comes out. The third is timed the same way the
 * first is — `CLEAN` either side of the bite is a properly driven shift, out to
 * `LOOSE` is a fumble worth one grade, and anything wider (including never
 * getting back on the gas at all) is worth two and forfeits the reward.
 *
 * The windows are wider than the rpm ones on purpose: this is a reaction to an
 * event the player can see coming, not a needle they have to read, and stacking
 * two tight windows on one shift would make the whole thing feel arbitrary.
 */
export const CATCH_CLEAN_SECONDS = 0.12;
export const CATCH_LOOSE_SECONDS = 0.3;

/**
 * How each grade affects the car coming out of the shift. `forceMultiplier`
 * scales drive force for `boostSeconds`; `clutchSeconds` is the dead time before
 * drive is restored at all.
 */
export const GRADE_EFFECTS = {
  perfect: { forceMultiplier: 1.15, boostSeconds: 1.2, clutchSeconds: 0.12 },
  good: { forceMultiplier: 1.05, boostSeconds: 0.8, clutchSeconds: 0.2 },
  poor: { forceMultiplier: 0.88, boostSeconds: 1.0, clutchSeconds: 0.32 },
  missed: { forceMultiplier: 0.7, boostSeconds: 1.6, clutchSeconds: 0.6 },
};

/**
 * Launch. Reaction time is measured from the green bulb to the throttle, the
 * way a drag strip measures it. Touching the throttle before green is a foul.
 */
export const LAUNCH_PERFECT_WINDOW = 0.15; // 9 ticks at 60hz
export const LAUNCH_GOOD_WINDOW = 0.35; // 21 ticks

/**
 * A red light bogs the car rather than disqualifying it: the run still produces
 * a time, so a solo time attack is never wasted, but the loss is large enough to
 * decide a side-by-side race the way a real red light would.
 */
export const LAUNCH_EFFECTS = {
  holeshot: { forceMultiplier: 1.25, boostSeconds: 1.6 },
  good: { forceMultiplier: 1.1, boostSeconds: 1.1 },
  late: { forceMultiplier: 1, boostSeconds: 0 },
  foul: { forceMultiplier: 0.45, boostSeconds: 2.2 },
};
