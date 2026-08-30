export const CONFIG = Object.freeze({
  eyeHeight: 1.7,
  crouchEyeHeight: 1.02,
  crouchSpeed: 2.45,
  walkSpeed: 4.2,
  sprintSpeed: 6.8,
  playerRadius: 0.34,
  bodyHeight: 1.78,
  groundSnap: 0.62,
  interactDistance: 3,
  floorHeight: 4.6,
  doorOpenAngle: Math.PI / 2,
  doorSpeed: 5.2,
  drawerSpeed: 2.4,
  elevatorSpeed: 2.15,
  elevatorDoorSpeed: 1.35,
  elevatorCenterX: 2.5,
  elevatorCenterZ: 57.45,
  elevatorFrontZ: 55.88,
  elevatorHalfWidth: 1.25,
  elevatorHalfDepth: 1.6,
  enemyWalkSpeed: 2.25,
  enemyChaseSpeed: 4.85,
  chaseAwarenessDistance: 10,
  enemyHuntSpeed: 3.05,
  enemyCatchDistance: 1.05,
});

// The anti-camping clock. Tuned so a room is a viable hiding place for a while but never forever,
// and so walking the length of one corridor is enough to clear a meter you let fill.
export const HEAT_CONFIG = Object.freeze({
  fillSeconds: 40,
  hallwayStepDistance: 7,
  roomHalfSize: 4,
  floorPenalty: 26,
  tunnelDrainSeconds: 12,
});

// The sprint meter. Six seconds of running is roughly one corridor, so sprinting buys an escape from
// a room but never a lap of the hotel; the walk-recovery rate is deliberately the slowest, so the
// safe way to get it back is to stop moving and hide.
export const STAMINA_CONFIG = Object.freeze({
  sprintSeconds: 6,
  walkRecoverSeconds: 14,
  restRecoverSeconds: 7,
  crouchRecoverSeconds: 5,
  recoverThreshold: 0.35,
});

// Two minutes of continuous use keeps the flashlight useful without making darkness irrelevant.
// Charge is normalized from 0..1 in snapshots so a server can add dropped batteries exactly.
export const FLASHLIGHT_CONFIG = Object.freeze({
  drainSeconds: 120,
});

// The hiding phase has a countdown because it physically holds the seeker in the elevator. Once the
// doors open, the hunt has no time limit: it ends when every guest is out or The Bellhop gets you.
// The head start is long enough for a hider to reach any floor and short enough not to be a loading
// screen.
export const ROUND_CONFIG = Object.freeze({
  durationSeconds: null,
  hideSeconds: 45,
  tagDistance: 1.9,
  tagHeightTolerance: 1.4,
  // The demon's reach when it walks into a hider. Slightly longer than its reach for the player,
  // because a hider is standing still and has no camera to flinch with.
  demonCatchDistance: 1.2,
  hiderCount: 3,
});

// The offline hiders. They panic at the seeker from further out than at the demon: a seeker with a
// plan is worth moving for, while bolting early from a roaming demon just makes you the loudest
// thing on the floor.
export const HIDER_CONFIG = Object.freeze({
  seekerPanicDistance: 9,
  demonPanicDistance: 7,
  calmSeconds: 4,
  settleSeconds: 1.5,
  spotSpreadDistance: 12,
  floorPenalty: 26,
  settleSpeed: 2.4,
  fleeSpeed: 4.6,
  safeDistanceCap: 60,
});

export const floorY = (id) => (id - 1) * CONFIG.floorHeight;
export const keyIdForFloor = (id) => `floor-${id}-master`;
export const keyLabelForFloor = (id) => `Floor ${id} Master Key`;

export const FLOOR_DEFS = Object.freeze([
  { id: 1, name: 'Lobby Floor', openRooms: ['105', '111'], lockedRooms: ['107', '113'], roomVariants: { 111: 'suite', 113: 'maintenance' }, keyPlacements: { 105: keyIdForFloor(1) }, secretRooms: ['105', '107'], secretLinks: [['105', '107']] },
  { id: 2, name: 'Lounge Floor', openRooms: ['202', '208', '213'], lockedRooms: ['204', '210'], roomVariants: { 202: 'suite', 204: 'maintenance', 213: 'suite' }, keyPlacements: { 204: keyIdForFloor(2) }, secretRooms: ['202', '204'], secretLinks: [['202', '204']] },
  { id: 3, name: 'Quiet Floor', openRooms: ['305', '312'], lockedRooms: ['302', '307', '308', '314'], roomVariants: { 305: 'suite', 314: 'maintenance' }, keyPlacements: { 305: keyIdForFloor(3) }, secretRooms: ['305', '307'], secretLinks: [['305', '307']] },
  { id: 4, name: 'Renovation Floor', openRooms: ['405', '412'], lockedRooms: ['402', '407', '408', '414'], roomVariants: { 407: 'maintenance', 414: 'maintenance' }, keyPlacements: { 407: keyIdForFloor(4) }, secretRooms: ['405', '407'], secretLinks: [['405', '407']] },
]);

export const inspectionViews = Object.freeze({
  stair: { x: 6.75, y: 1.78, z: 43.8, yaw: Math.PI, pitch: 0.08 },
  stairEntrance: { x: 2.35, y: floorY(2) + 1.78, z: 44.15, yaw: -Math.PI / 2, pitch: 0 },
  doorway: { x: 0, y: floorY(4) + CONFIG.eyeHeight, z: 10, yaw: Math.PI / 2, pitch: 0 },
  monster: { x: 0, y: CONFIG.eyeHeight, z: 31.5, yaw: 0, pitch: 0 },
  avatar: { x: 0, y: CONFIG.eyeHeight, z: 31.5, yaw: 0, pitch: 0 },
});
