// Barnyard Dash courses, as DATA.
//
// A course is a closed centre line (`road`), a width, and features placed by
// how far round the lap they sit (`at`, a fraction of one lap measured from
// the start line) rather than by coordinates — so a hurdle always spans the
// road it stands on, faces the way the racers run, and moves with the road if
// the road is retuned. Checkpoint gates are laid evenly round the lap, the
// last one on the finish line. Scenery (trees, the barn, the pond) is data too
// and a test keeps every piece of it outside the fence.
//
// The first course is the hand-authored original (track.js DEFAULT_TRACK) and
// keeps its exact geometry, so nothing anybody learned on it changes.
//
// Pure: the network server mirrors this folder and races these same courses.

import { DEFAULT_TRACK, FENCE_OFFSET, pointAtStation, roadLength, withCheckpointGates } from "./track.js?v=20260928-pet-online";

const START_TO_FINISH = 40;
const CHECKPOINTS_PER_LAP = 7;

function closedRoad(points) {
  const [firstX, firstY] = points[0];
  const [lastX, lastY] = points[points.length - 1];
  const road = firstX === lastX && firstY === lastY ? points : [...points, points[0]];
  return Object.freeze(road.map(([x, y]) => Object.freeze({ x, y })));
}

/** A lap fraction to a road point, counted from the finish line. */
function place(track, at, offset = 0) {
  const length = roadLength(track);
  const point = pointAtStation(track, START_TO_FINISH + at * length);
  const across = { x: -Math.sin(point.angle), y: Math.cos(point.angle) };
  const lateral = offset * (track.roadWidth / 2);
  return { x: point.x + across.x * lateral, y: point.y + across.y * lateral, angle: point.angle };
}

// A gate on the apex of a sharp bend can be missed by a pet cutting inside it
// (its line faces one leg of the bend and the pet never reaches it), so
// checkpoints are moved onto the straight just past any sharp corner.
const SHARP_BEND = 0.6;
const BEND_CLEARANCE = 90;

function sharpBends(track) {
  const road = track.road;
  const bends = [];
  let station = 0;
  for (let index = 1; index < road.length; index += 1) {
    station += Math.hypot(road[index].x - road[index - 1].x, road[index].y - road[index - 1].y);
    const next = road[index + 1] ?? road[1];
    const incoming = Math.atan2(road[index].y - road[index - 1].y, road[index].x - road[index - 1].x);
    const outgoing = Math.atan2(next.y - road[index].y, next.x - road[index].x);
    if (Math.abs(Math.atan2(Math.sin(outgoing - incoming), Math.cos(outgoing - incoming))) > SHARP_BEND) bends.push(station);
  }
  return bends;
}

function clearOfBends(station, bends, length) {
  for (const bend of bends) {
    const offset = ((station - bend) % length + length) % length;
    const gap = Math.min(offset, length - offset);
    if (gap < BEND_CLEARANCE) return bend + BEND_CLEARANCE;
  }
  return station;
}

function feature(track, spec, index) {
  const at = place(track, spec.at, spec.offset ?? 0);
  const id = `${spec.kind}-${index + 1}`;
  const round = (value) => Math.round(value * 100) / 100;
  if (spec.kind === "hurdle") {
    return Object.freeze({ id, kind: "hurdle", x: round(at.x), y: round(at.y), length: track.roadWidth - 16, thickness: 4, angle: round(at.angle + Math.PI / 2) });
  }
  if (spec.kind === "gate") {
    return Object.freeze({ id, kind: "gate", x: round(at.x), y: round(at.y), length: spec.length ?? 52, thickness: 5, angle: round(at.angle + Math.PI / 2) });
  }
  return Object.freeze({ id, kind: "hay", x: round(at.x), y: round(at.y), radius: spec.radius ?? 21 });
}

function buildCourse(spec) {
  const road = closedRoad(spec.road);
  const base = { road, roadWidth: spec.roadWidth ?? 132 };
  const length = roadLength(base);
  const startPoint = pointAtStation(base, 0);
  const finishPoint = pointAtStation(base, START_TO_FINISH);
  const bends = sharpBends(base);
  const checkpoints = Array.from({ length: CHECKPOINTS_PER_LAP }, (_, index) => {
    const station = index === CHECKPOINTS_PER_LAP - 1
      ? START_TO_FINISH
      : clearOfBends(START_TO_FINISH + (length * (index + 1)) / CHECKPOINTS_PER_LAP, bends, length);
    const point = pointAtStation(base, station);
    return Object.freeze({ x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 });
  });
  const mud = (spec.mud ?? []).map((entry) => {
    const at = place(base, entry.at, entry.offset ?? 0);
    return Object.freeze({ x: Math.round(at.x), y: Math.round(at.y), width: entry.width, height: entry.height });
  });
  const obstacles = (spec.features ?? []).map((entry, index) => feature(base, entry, index));
  return withCheckpointGates(Object.freeze({
    ...base,
    start: Object.freeze({ x: startPoint.x, y: startPoint.y, angle: startPoint.angle }),
    finish: Object.freeze({ x: finishPoint.x, y: finishPoint.y, angle: finishPoint.angle }),
    checkpoints: Object.freeze(checkpoints),
    mud: Object.freeze(mud),
    obstacles: Object.freeze(obstacles),
  }));
}

function course(meta, track) {
  return Object.freeze({
    id: meta.id,
    title: meta.title,
    blurb: meta.blurb,
    laps: meta.laps ?? 3,
    // Scenery in track units: never simulated, only kept clear of the course.
    scenery: Object.freeze({
      trees: Object.freeze((meta.trees ?? []).map(([x, y]) => Object.freeze({ x, y }))),
      barn: meta.barn ? Object.freeze({ x: meta.barn[0], y: meta.barn[1], angle: meta.barn[2] ?? 0 }) : null,
      pond: meta.pond ? Object.freeze({ x: meta.pond[0], y: meta.pond[1], radius: meta.pond[2] }) : null,
      hay: Object.freeze((meta.hay ?? []).map(([x, y]) => Object.freeze({ x, y }))),
    }),
    track,
  });
}

export const COURSES = Object.freeze([
  course({
    id: "barnyard-loop",
    title: "Barnyard Loop",
    blurb: "The original lap: seven hurdles, two mud wallows and a gate worth smashing.",
    trees: [[-45, -30], [42, 670], [930, -55], [1017, 595], [418, 745], [705, 757]],
    barn: [380, 332],
  }, DEFAULT_TRACK),

  course({
    id: "orchard-esses",
    title: "Orchard Esses",
    blurb: "A snaking run through the apple rows. Brake early, flick late.",
    trees: [[300, 290], [460, 470], [250, 540], [760, 180], [700, 70], [1260, 300], [1230, 650], [960, 830], [520, 850], [-20, 420], [-10, 180], [880, 470], [400, -60], [1200, 40]],
    barn: [350, 420, 0.2],
    hay: [[860, 490], [900, 520]],
  }, buildCourse({
    road: [[140, 620], [130, 380], [180, 180], [330, 100], [490, 170], [570, 330], [700, 410], [860, 330], [960, 170], [1090, 190], [1120, 380], [1050, 570], [860, 650], [620, 670], [380, 690], [220, 690]],
    features: [
      { kind: "hurdle", at: 0.1 },
      { kind: "hurdle", at: 0.25 },
      { kind: "hay", at: 0.33, offset: -0.45 },
      { kind: "hurdle", at: 0.41 },
      { kind: "hurdle", at: 0.56 },
      { kind: "gate", at: 0.68, offset: 0.35 },
      { kind: "hurdle", at: 0.78 },
      { kind: "hay", at: 0.88, offset: 0.4 },
    ],
    mud: [
      { at: 0.47, width: 120, height: 110 },
      { at: 0.73, offset: -0.35, width: 90, height: 120 },
    ],
  })),

  course({
    id: "millpond-oval",
    title: "Millpond Oval",
    blurb: "Flat out round the millpond. The straights are fast; the ends are mud.",
    laps: 4,
    trees: [[-40, 380], [-30, 120], [1100, 120], [1110, 560], [560, -90], [300, 760], [820, 770], [1150, 380]],
    pond: [560, 355, 125],
    hay: [[430, 250], [690, 460]],
  }, buildCourse({
    road: [[170, 560], [150, 380], [170, 200], [260, 120], [450, 100], [670, 100], [860, 120], [950, 200], [975, 380], [950, 540], [860, 610], [660, 620], [450, 620], [260, 610]],
    features: [
      { kind: "hurdle", at: 0.12 },
      { kind: "hay", at: 0.25, offset: 0.4 },
      { kind: "hay", at: 0.3, offset: -0.4 },
      { kind: "hurdle", at: 0.38 },
      { kind: "hurdle", at: 0.6 },
      { kind: "gate", at: 0.74, offset: -0.4 },
      { kind: "gate", at: 0.79, offset: 0.4 },
      { kind: "hurdle", at: 0.9 },
    ],
    mud: [
      { at: 0.46, width: 150, height: 170 },
      { at: 0.97, width: 150, height: 150 },
    ],
  })),

  course({
    id: "hayloft-hairpins",
    title: "Hayloft Hairpins",
    blurb: "Four hairpins stacked like hay bales. Whoever brakes best, wins.",
    laps: 2,
    trees: [[-40, 460], [-20, 820], [1200, 100], [1200, 440], [1210, 760], [620, -60], [600, 440], [300, 920], [900, 930]],
    barn: [620, 920, 0],
    hay: [[640, 230], [680, 230], [820, 640]],
  }, buildCourse({
    roadWidth: 124,
    road: [
      [130, 720], [125, 420], [140, 190], [210, 115], [400, 105], [700, 105], [900, 110],
      [1010, 140], [1050, 220], [1010, 300], [900, 330], [700, 335], [480, 335],
      [380, 360], [340, 435], [380, 510], [480, 540], [700, 545], [900, 545],
      [1010, 575], [1050, 650], [1010, 725], [900, 750], [600, 755], [300, 755], [190, 750],
    ],
    features: [
      { kind: "hurdle", at: 0.07 },
      { kind: "hurdle", at: 0.2 },
      { kind: "hay", at: 0.36, offset: 0.4 },
      { kind: "hurdle", at: 0.45 },
      { kind: "gate", at: 0.55, offset: -0.35 },
      { kind: "hurdle", at: 0.66 },
      { kind: "hurdle", at: 0.84 },
      { kind: "hay", at: 0.9, offset: -0.4 },
    ],
    mud: [
      { at: 0.29, width: 120, height: 120 },
      { at: 0.61, width: 120, height: 120 },
    ],
  })),

  course({
    id: "thunder-ridge",
    title: "Thunder Ridge",
    blurb: "The long one: big sweepers over the ridge, a gate gauntlet and a mud-bottom valley.",
    laps: 2,
    trees: [[-60, 420], [-40, 140], [460, 290], [420, 520], [1060, 120], [1450, 260], [1440, 700], [1000, 1000], [520, 1010], [760, -80], [240, -60]],
    barn: [720, 470, -0.3],
    pond: [620, 700, 90],
    hay: [[1100, 560], [1130, 595]],
  }, buildCourse({
    road: [
      [160, 740], [140, 480], [190, 260], [330, 110], [560, 60], [790, 100], [930, 220], [1010, 420],
      [1130, 300], [1290, 290], [1360, 440], [1310, 640],
      [1150, 790], [920, 880], [640, 900], [380, 880], [220, 830],
    ],
    features: [
      { kind: "hurdle", at: 0.06 },
      { kind: "hurdle", at: 0.16 },
      { kind: "hay", at: 0.23, offset: 0.35 },
      { kind: "hurdle", at: 0.3 },
      { kind: "gate", at: 0.4, offset: 0.35 },
      { kind: "gate", at: 0.45, offset: -0.35 },
      { kind: "hurdle", at: 0.52 },
      { kind: "hurdle", at: 0.62 },
      { kind: "hay", at: 0.7, offset: -0.4 },
      { kind: "hurdle", at: 0.78 },
      { kind: "gate", at: 0.86, offset: 0.35 },
      { kind: "hurdle", at: 0.93 },
    ],
    mud: [
      { at: 0.35, width: 110, height: 130 },
      { at: 0.74, width: 160, height: 120 },
      { at: 0.82, offset: 0.3, width: 110, height: 110 },
    ],
  })),
]);

export const DEFAULT_COURSE_ID = "barnyard-loop";
export const COURSE_IDS = Object.freeze(COURSES.map((entry) => entry.id));

export function findCourse(id) {
  return COURSES.find((entry) => entry.id === id) ?? null;
}

export function courseOrDefault(id) {
  return findCourse(id) ?? findCourse(DEFAULT_COURSE_ID);
}

/** Pick a course for a quick online room deterministically from its seed. */
export function courseForSeed(seed) {
  let value = 0;
  for (const character of String(seed)) value = (Math.imul(value, 31) + character.charCodeAt(0)) >>> 0;
  return COURSES[value % COURSES.length];
}

export { FENCE_OFFSET };
