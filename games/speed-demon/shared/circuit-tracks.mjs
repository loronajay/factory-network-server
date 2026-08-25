// The authoritative track catalog. Coordinates mirror the browser cabinet;
// masks with the same ids live under ../assets and decide driveable pixels.

const checkpoint = (x, y) => Object.freeze({ x, y, radius: 112 });

export const OLD_TOWN_SHRINE_TRACK = Object.freeze({
  id: "old-town-shrine-loop",
  spawns: Object.freeze([
    Object.freeze({ x: 610, y: 850, angle: Math.PI / 2 }),
    Object.freeze({ x: 610, y: 825, angle: Math.PI / 2 }),
  ]),
  checkpoints: Object.freeze([
    checkpoint(622, 861), checkpoint(1324, 723), checkpoint(1273, 311),
    checkpoint(662, 139), checkpoint(171, 319), checkpoint(503, 472),
    checkpoint(806, 489), checkpoint(781, 661), checkpoint(227, 723),
  ]),
});

export const DOCKLANDS_FREIGHT_TRACK = Object.freeze({
  id: "docklands-freight-loop",
  spawns: Object.freeze([
    Object.freeze({ x: 720, y: 820, angle: Math.PI / 2 }),
    Object.freeze({ x: 720, y: 850, angle: Math.PI / 2 }),
  ]),
  checkpoints: Object.freeze([
    checkpoint(720, 835), checkpoint(1375.327, 726.102), checkpoint(1204.727, 359.922),
    checkpoint(802.778, 196.111), checkpoint(813.05, 390.642), checkpoint(764.097, 621.668),
    checkpoint(482.037, 530.741), checkpoint(172.188, 522.031), checkpoint(118.192, 764.899),
  ]),
});

export const DOWNTOWN_CANAL_TRACK = Object.freeze({
  id: "downtown-canal-ring",
  spawns: Object.freeze([
    Object.freeze({ x: 845, y: 820, angle: Math.PI / 2 }),
    Object.freeze({ x: 845, y: 850, angle: Math.PI / 2 }),
  ]),
  checkpoints: Object.freeze([
    checkpoint(845, 835), checkpoint(1373.676, 664.252), checkpoint(1333.025, 146.989),
    checkpoint(1161.667, 261.296), checkpoint(922.167, 490.274), checkpoint(640.117, 354.863),
    checkpoint(359.444, 241.481), checkpoint(180.638, 207.682), checkpoint(151.584, 756.351),
  ]),
});

export const CIRCUIT_TRACKS = Object.freeze([
  OLD_TOWN_SHRINE_TRACK,
  DOCKLANDS_FREIGHT_TRACK,
  DOWNTOWN_CANAL_TRACK,
]);
export const CIRCUIT_TRACK_IDS = Object.freeze(CIRCUIT_TRACKS.map((track) => track.id));
export const DEFAULT_CIRCUIT_TRACK_ID = OLD_TOWN_SHRINE_TRACK.id;
export const circuitTrackById = (id) => CIRCUIT_TRACKS.find((track) => track.id === id) ?? null;
