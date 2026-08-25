// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/sim/modes.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

// The mode catalog.
//
// One list, read by two very different callers: the mode-select screen draws
// from it, and `createRace` is built from it. That is deliberate — a mode is not
// a branch in the menu code, it is a row here, so adding one is data.
//
// Every mode carries an **objective**: the thing the race is measured against,
// and the thing the setup screen's third pane picks. A distance race is measured
// in metres, a time attack in seconds, and `raceOptionsFor` hands whichever one
// applies straight to `createRace`. Nothing downstream needs to know the mode's
// name to run it, which is what keeps `race.js` free of mode branches.

import { RACE_DISTANCES, DEFAULT_DISTANCE_ID } from "./constants.mjs";

export const MODE_DISTANCE = "distance";
export const MODE_TIME_ATTACK = "time-attack";
export const MODE_RIVAL = "rival";
export const MODE_ONLINE = "online";
export const MODE_CIRCUIT = "circuit";

/** What a mode measures. The race only ever sees one of these two. */
export const OBJECTIVE_DISTANCE = "distance";
export const OBJECTIVE_TIME = "time";
export const OBJECTIVE_LAPS = "laps";

/** The distances, in the order they read on the strip. Ids match RACE_DISTANCES. */
const DISTANCE_OPTIONS = ["eighth", "quarter", "half", "mile"].map((id) => ({
  id,
  label: RACE_DISTANCES[id].label,
  metres: RACE_DISTANCES[id].metres,
}));

/**
 * Time Attack clocks. Short enough that a bad run is cheap to abandon, long
 * enough that the run is about sustained shifting rather than one launch.
 */
const CLOCK_OPTIONS = [
  { id: "sprint", label: "60 SEC", seconds: 60 },
  { id: "standard", label: "90 SEC", seconds: 90 },
  { id: "endurance", label: "2 MIN", seconds: 120 },
];

const LAP_OPTIONS = [
  { id: "one-lap", label: "1 LAP", laps: 1 },
  { id: "three-laps", label: "3 LAPS", laps: 3 },
  { id: "five-laps", label: "5 LAPS", laps: 5 },
];

export const MODES = [
  {
    id: MODE_DISTANCE,
    runtime: "drag",
    label: "Distance Race",
    blurb: "One car, one strip, one time. Launch clean, and lift-shift-catch every gear over a fixed distance.",
    available: true,
    objective: {
      kind: OBJECTIVE_DISTANCE,
      label: "DISTANCE",
      options: DISTANCE_OPTIONS,
      defaultId: DEFAULT_DISTANCE_ID,
    },
  },
  {
    id: MODE_RIVAL,
    runtime: "drag",
    label: "Rival Race",
    blurb: "Two cars, one strip, nobody watching. Pick somebody to beat — a driver from the roster, or your own best run.",
    available: true,
    /**
     * The setup screen grows a fifth pane in this mode, and only in this mode.
     * A flag rather than a pane list because that is all the difference is: the
     * rival is picked *after* the objective, since which ghost exists depends on
     * which board the run will file to.
     */
    rival: true,
    /**
     * Where a run in this mode files its time.
     *
     * A rival race is a distance race with company. The rival is in the other
     * lane and cannot touch you — `sim/` has no lateral axis at all, so there is
     * no mechanism by which their car could change yours — which means the run
     * is physically identical to a solo one over the same distance and belongs
     * on the same board. Giving it boards of its own would split one ladder in
     * two and, worse, break the loop this mode exists for: beat your ghost, set
     * a new best, race the new ghost.
     */
    recordsAs: MODE_DISTANCE,
    objective: {
      kind: OBJECTIVE_DISTANCE,
      label: "DISTANCE",
      options: DISTANCE_OPTIONS,
      defaultId: DEFAULT_DISTANCE_ID,
    },
  },
  {
    id: MODE_TIME_ATTACK,
    runtime: "drag",
    label: "Time Attack",
    blurb: "Endless road, fixed clock. Cover as much ground as you can before it runs out.",
    available: true,
    objective: {
      kind: OBJECTIVE_TIME,
      label: "CLOCK",
      options: CLOCK_OPTIONS,
      defaultId: "standard",
    },
  },
  {
    id: MODE_CIRCUIT,
    runtime: "circuit",
    label: "Circuit Race",
    blurb: "Two-axis racing on circuits across the campaign map. Hit every checkpoint, complete the laps, and finish first.",
    available: true,
    objective: {
      kind: OBJECTIVE_LAPS,
      label: "LAPS",
      options: LAP_OPTIONS,
      defaultId: "three-laps",
    },
  },
  {
    id: MODE_ONLINE,
    runtime: "drag",
    label: "Online Versus",
    blurb: "Two cars side by side, best of three. Jump the light twice in a round and you forfeit it.",
    available: true,
    /**
     * Online does not use the solo setup screen: the strip, the distance and the
     * match length belong to the room both drivers are in, not to one of them.
     * The shell reads this to send the player to the lobby instead.
     */
    online: true,
    note: "Casual — quick search or a private room code",
    objective: {
      kind: OBJECTIVE_DISTANCE,
      label: "DISTANCE",
      options: DISTANCE_OPTIONS,
      defaultId: DEFAULT_DISTANCE_ID,
    },
  },
];

export const DEFAULT_MODE_ID = MODE_DISTANCE;

export function modeById(id) {
  return MODES.find((mode) => mode.id === id) ?? null;
}

/**
 * The mode whose boards this mode's runs are filed under — itself, unless it
 * says otherwise.
 *
 * One indirection, in the catalog, so `records.js` never has to name a mode that
 * borrows another's boards. A second mode wanting the same thing is a field on
 * its row rather than a branch anywhere.
 */
export function boardModeId(modeId) {
  const mode = modeById(modeId);
  return mode?.recordsAs ?? modeId;
}

/** The modes a player can actually start. Locked ones still render, greyed. */
export function playableModes() {
  return MODES.filter((mode) => mode.available);
}

/**
 * The chosen option, falling back to the mode's default. A saved selection that
 * no longer exists opens on something valid rather than on nothing — the same
 * rule the car and track cursors follow.
 */
export function objectiveOption(mode, optionId) {
  return (
    mode.objective.options.find((option) => option.id === optionId) ??
    mode.objective.options.find((option) => option.id === mode.objective.defaultId) ??
    mode.objective.options[0]
  );
}

/**
 * The objective half of a `createRace` call. Exactly one of the two is named and
 * the other is explicitly null, because a race with both — or neither — is not a
 * race, and `createRace` rejects it.
 */
export function raceOptionsFor(modeId, optionId) {
  const mode = modeById(modeId);
  if (!mode) {
    throw new Error(`No such mode: ${modeId}`);
  }
  const option = objectiveOption(mode, optionId);
  if (mode.objective.kind === OBJECTIVE_LAPS) return { laps: option.laps };
  return mode.objective.kind === OBJECTIVE_TIME
    ? { distanceMetres: null, timeLimitSeconds: option.seconds }
    : { distanceMetres: option.metres, timeLimitSeconds: null };
}
