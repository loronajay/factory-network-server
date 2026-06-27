// Tiny deterministic PRNG so a penalty's internal randomness (sequences, targets)
// is reproducible from a seed handed down by the match engine.
export function makePenaltyRng(seed) {
  let state = (Math.abs(Math.floor(Number(seed))) || 1) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}
