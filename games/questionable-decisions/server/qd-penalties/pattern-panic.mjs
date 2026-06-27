// Pattern Panic: react to the lit face button. The server holds a sequence of face
// targets (A/B/X/Y); the controller lights the current one and the display shows it
// big. Pressing the matching face advances; a wrong face is a miss. Speed test, not
// memory — the target is visible on both surfaces. Clearing the sequence = no loss.
import { makePenaltyRng } from "./penalty-rng.mjs";

export const PATTERN_PANIC_TARGETS = ["A", "B", "X", "Y"];

function buildSequence(seed, length) {
  const rng = makePenaltyRng(seed);
  const sequence = [];
  for (let i = 0; i < length; i += 1) {
    let target;
    do {
      target = PATTERN_PANIC_TARGETS[Math.floor(rng() * PATTERN_PANIC_TARGETS.length)];
    } while (i > 0 && target === sequence[i - 1]); // avoid trivial repeats
    sequence.push(target);
  }
  return sequence;
}

export const patternPanicPenalty = {
  penaltyId: "pattern-panic",
  displayName: "Pattern Panic",
  weight: 3,
  promptText: "Smash the lit button before it jumps.",

  init({ sourceValue, seed }) {
    const required = 5 + Math.round(sourceValue / 100); // 100 -> 6 ... 400 -> 9
    return { sequence: buildSequence(seed, required), index: 0, hits: 0, misses: 0, required };
  },

  input(state, inputToken) {
    if (state.index >= state.required) return state;
    if (!PATTERN_PANIC_TARGETS.includes(inputToken)) return state; // d-pad / shoulders ignored
    if (inputToken === state.sequence[state.index]) {
      return { ...state, index: state.index + 1, hits: state.hits + 1 };
    }
    return { ...state, misses: state.misses + 1 };
  },

  status(state) {
    return `${state.hits} / ${state.required}`;
  },

  resolve(state, { maxLoss }) {
    const hits = Math.min(state.hits, state.required);
    const ratioLost = state.required > 0 ? 1 - hits / state.required : 1;
    return { pointsLost: Math.round(maxLoss * ratioLost), statusText: `${hits} / ${state.required} hit` };
  },

  serializePublic(state) {
    return {
      kind: "targets",
      target: state.index < state.required ? state.sequence[state.index] : null,
      hits: state.hits,
      misses: state.misses,
      required: state.required,
    };
  },

  serializePrivate(state) {
    return { litButtons: state.index < state.required ? [state.sequence[state.index]] : [] };
  },
};
