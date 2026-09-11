// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/circuit/tracks.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

import { CIRCUIT_WORLD } from "./config.mjs";
import { DOCKLANDS_TRACK_DATA } from "./docklands-track-data.mjs";
import { DOWNTOWN_CANAL_TRACK_DATA } from "./downtown-canal-track-data.mjs";

export const OLD_TOWN_SHRINE_LINE = Object.freeze([
  { x: 622, y: 861 }, { x: 973, y: 860 }, { x: 1216, y: 807 },
  { x: 1324, y: 723 }, { x: 1381, y: 574 }, { x: 1354, y: 417 },
  { x: 1273, y: 311 }, { x: 1104, y: 232 }, { x: 879, y: 179 },
  { x: 662, y: 139 }, { x: 337, y: 153 }, { x: 194, y: 258 },
  { x: 171, y: 319 }, { x: 185, y: 387 }, { x: 274, y: 477 },
  { x: 503, y: 472 }, { x: 647, y: 431 }, { x: 763, y: 461 },
  { x: 806, y: 489 }, { x: 841, y: 554 }, { x: 826, y: 601 },
  { x: 781, y: 661 }, { x: 558, y: 705 }, { x: 377, y: 705 },
  { x: 227, y: 723 }, { x: 183, y: 785 }, { x: 365, y: 861 },
]);

const CHECKPOINT_INDICES = [0, 3, 6, 9, 12, 15, 18, 21, 24];
const oldTownCheckpoints = CHECKPOINT_INDICES.map((index) => Object.freeze({
  ...OLD_TOWN_SHRINE_LINE[index],
  // The broadest legal line is 106 world units from the racing line. Leave a
  // little tolerance so driving beside the barrier cannot silently void a lap.
  radius: 112,
}));

const docklandsLine = Object.freeze(DOCKLANDS_TRACK_DATA.racingLine.map(Object.freeze));
const docklandsCheckpoints = DOCKLANDS_TRACK_DATA.checkpointIndices.map((index) => Object.freeze({
  ...docklandsLine[index],
  radius: 112,
}));
const downtownCanalLine = Object.freeze(DOWNTOWN_CANAL_TRACK_DATA.racingLine.map(Object.freeze));
const downtownCanalCheckpoints = DOWNTOWN_CANAL_TRACK_DATA.checkpointIndices.map((index) => Object.freeze({
  ...downtownCanalLine[index],
  radius: 112,
}));

const presentation = (carScale, minZoom, maxZoom) => Object.freeze({
  carScale,
  camera: Object.freeze({ minZoom, maxZoom }),
});

export const CIRCUIT_TRACKS = Object.freeze([
  Object.freeze({
    id: "old-town-shrine-loop",
    label: "Old Town Shrine Loop",
    setupLabel: "Old Town",
    blurb: "A wet shrine road above Old Town, folding back through a technical infield.",
    circuit: true,
    src: "assets/circuit-tracks/old-town-shrine-loop.png",
    image: "assets/circuit-tracks/old-town-shrine-loop.png",
    roadMask: "assets/circuit-tracks/old-town-shrine-loop-road-mask.png",
    world: CIRCUIT_WORLD,
    presentation: presentation(1, 1.65, 2),
    spawns: Object.freeze([
      Object.freeze({ x: 610, y: 850, angle: Math.PI / 2 }),
      // A two-wide grid on one start line. The old second slot was 40 world
      // units farther east — already ahead in the direction both cars face.
      Object.freeze({ x: 610, y: 825, angle: Math.PI / 2 }),
    ]),
    checkpoints: Object.freeze(oldTownCheckpoints),
    racingLine: OLD_TOWN_SHRINE_LINE,
  }),
  Object.freeze({
    id: "docklands-freight-loop",
    label: "Docklands Freight Loop",
    setupLabel: "Docklands",
    blurb: "A fast harbor sweep joined to a tight freight-yard infield.",
    circuit: true,
    src: "assets/circuit-tracks/docklands-freight-loop.png",
    image: "assets/circuit-tracks/docklands-freight-loop.png",
    roadMask: "assets/circuit-tracks/docklands-freight-loop-road-mask.png",
    world: CIRCUIT_WORLD,
    presentation: presentation(1, 1.65, 2),
    spawns: Object.freeze([
      Object.freeze({ x: 720, y: 820, angle: Math.PI / 2 }),
      Object.freeze({ x: 720, y: 850, angle: Math.PI / 2 }),
    ]),
    checkpoints: Object.freeze(docklandsCheckpoints),
    racingLine: docklandsLine,
  }),
  Object.freeze({
    id: "downtown-canal-ring",
    label: "Downtown Canal Ring",
    setupLabel: "Downtown",
    blurb: "A rain-black canal circuit threading Downtown towers and elevated rail lines.",
    circuit: true,
    src: "assets/circuit-tracks/downtown-canal-ring.png",
    image: "assets/circuit-tracks/downtown-canal-ring.png",
    roadMask: "assets/circuit-tracks/downtown-canal-ring-road-mask.png",
    world: CIRCUIT_WORLD,
    // Downtown's lanes are materially thinner. More world-space zoom exposes
    // the road edge sooner while the smaller sprite keeps the car coherent.
    presentation: presentation(0.82, 2, 2.4),
    spawns: Object.freeze([
      Object.freeze({ x: 845, y: 820, angle: Math.PI / 2 }),
      Object.freeze({ x: 845, y: 850, angle: Math.PI / 2 }),
    ]),
    checkpoints: Object.freeze(downtownCanalCheckpoints),
    racingLine: downtownCanalLine,
  }),
]);

export const DEFAULT_CIRCUIT_TRACK_ID = "old-town-shrine-loop";
export const circuitTrackById = (id) => CIRCUIT_TRACKS.find((track) => track.id === id) ?? null;
