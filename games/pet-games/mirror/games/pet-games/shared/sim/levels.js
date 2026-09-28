// CPU difficulty levels shared by every Pet Games event.
//
// A level is an id and its words. What a level MEANS lives in each event's own
// cpu.js as a table of hand knobs (reaction, precision, aggression) keyed by
// these ids — difficulty is how well a CPU drives, never a better pet.

export const CPU_LEVELS = Object.freeze([
  Object.freeze({ id: "rookie", title: "Rookie", blurb: "Easygoing rivals who miss a few jumps." }),
  Object.freeze({ id: "pro", title: "Pro", blurb: "Clean lines and honest pressure." }),
  Object.freeze({ id: "champion", title: "Champion", blurb: "Sharp, patient and hard to shake." }),
]);

export const CPU_LEVEL_IDS = Object.freeze(CPU_LEVELS.map((level) => level.id));
export const DEFAULT_CPU_LEVEL = "pro";

export function normalizeCpuLevel(value) {
  return CPU_LEVEL_IDS.includes(value) ? value : DEFAULT_CPU_LEVEL;
}

/** The lobby carries a level as a small integer (a bounded primitive the network server keeps). */
export function cpuLevelFromIndex(index) {
  const value = Math.floor(Number(index));
  return CPU_LEVEL_IDS[Number.isFinite(value) ? Math.min(CPU_LEVEL_IDS.length - 1, Math.max(0, value)) : 1];
}

export function cpuLevelIndex(level) {
  return Math.max(0, CPU_LEVEL_IDS.indexOf(normalizeCpuLevel(level)));
}

export function findCpuLevel(id) {
  return CPU_LEVELS.find((level) => level.id === id) ?? CPU_LEVELS[1];
}
