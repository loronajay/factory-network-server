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
export const MODE_ONLINE = "online";

/** What a mode measures. The race only ever sees one of these two. */
export const OBJECTIVE_DISTANCE = "distance";
export const OBJECTIVE_TIME = "time";

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

export const MODES = [
  {
    id: MODE_DISTANCE,
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
    id: MODE_TIME_ATTACK,
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
    id: MODE_ONLINE,
    label: "Online Versus",
    blurb: "Two cars side by side over a fixed distance. Jump the light twice and the round is lost.",
    available: false,
    note: "In development — offline modes only for now",
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
  return mode.objective.kind === OBJECTIVE_TIME
    ? { distanceMetres: null, timeLimitSeconds: option.seconds }
    : { distanceMetres: option.metres, timeLimitSeconds: null };
}
