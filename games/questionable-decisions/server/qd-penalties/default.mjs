// Default penalty: a uniform "mash to survive" module. Any gamepad press counts as
// a hit toward a tier-scaled requirement; more hits = less point loss. Used by the
// penalties that don't yet have a bespoke two-surface module. Factory so several
// penaltyIds can share the behavior with their own name/flavor.
export function makeDefaultPenalty({ penaltyId, displayName, weight = 3, promptText = "Mash any button to survive." }) {
  return {
    penaltyId,
    displayName,
    weight,
    promptText,

    init({ sourceValue }) {
      return { required: 3 + Math.round(sourceValue / 100), hits: 0 };
    },

    input(state) {
      if (state.hits >= state.required) return state;
      return { ...state, hits: state.hits + 1 };
    },

    status(state) {
      return `${Math.min(state.hits, state.required)} / ${state.required}`;
    },

    resolve(state, { maxLoss }) {
      const hits = Math.min(state.hits, state.required);
      const ratioLost = state.required > 0 ? 1 - hits / state.required : 1;
      return { pointsLost: Math.round(maxLoss * ratioLost), statusText: `${hits} / ${state.required} survived` };
    },

    serializePublic(state) {
      return { kind: "mash", hits: Math.min(state.hits, state.required), required: state.required };
    },

    // Any button works, so nothing is specifically lit.
    serializePrivate() {
      return { litButtons: [] };
    },
  };
}
