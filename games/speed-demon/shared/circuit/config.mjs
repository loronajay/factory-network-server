// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/circuit/config.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

export const CIRCUIT_WORLD = Object.freeze({ width: 1536, height: 1024 });
export const CIRCUIT_FIXED_STEP = 1 / 120;

export const VEHICLE_TUNING = Object.freeze({
  acceleration: 245,
  reverseAcceleration: 150,
  braking: 360,
  maxForwardSpeed: 350,
  maxReverseSpeed: 120,
  longitudinalDrag: 0.72,
  rollingResistance: 10,
  lateralGrip: 7.5,
  turnRate: 3.15,
  steerResponse: 11,
  yawResponse: 14,
  fullSteerSpeed: 62,
  highSpeedSteerScale: 650,
});

export const CPU_VEHICLE_TUNING = Object.freeze({
  ...VEHICLE_TUNING,
  acceleration: 215,
  braking: 330,
  maxForwardSpeed: 275,
  turnRate: 3.05,
  highSpeedSteerScale: 560,
});

export const COLLISION_TUNING = Object.freeze({
  sweepStep: 1.5,
  rotationRadius: 22,
  restitution: 0.3,
  tangentialRetention: 0.86,
  separation: 0.75,
  normalProbeRadii: Object.freeze([2, 4, 6, 9, 12]),
  normalProbeDirections: 16,
  yawKick: 0.0045,
  maxImpactYaw: 1.8,
});

export const CAMERA_TUNING = Object.freeze({
  follow: 8.5,
  zoomFollow: 3.2,
  minZoom: 1.65,
  maxZoom: 2,
  maxLookAhead: 86,
  reverseLookAhead: 35,
});

export const VEHICLE_FOOTPRINT = Object.freeze({ halfLength: 16, halfWidth: 9 });
