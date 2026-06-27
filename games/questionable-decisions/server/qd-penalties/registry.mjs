// Penalty module registry — the single index of penalty mini-games the QD match
// engine can launch. The engine asks here (weighted pick + lookup) and never names
// a penalty directly. Add a penalty by importing it and listing it in PENALTIES.
import { makeDefaultPenalty } from "./default.mjs";
import { patternPanicPenalty } from "./pattern-panic.mjs";

const PENALTIES = [
  patternPanicPenalty,
  // Not-yet-bespoke penalties run on the uniform mash module for now (see
  // PENALTY_CONTRACT.md). Each gets its own two-surface module over time.
  makeDefaultPenalty({ penaltyId: "cabinet-says", displayName: "Cabinet Says", promptText: "Obey the cabinet. Keep tapping." }),
  makeDefaultPenalty({ penaltyId: "bomb-diffuser", displayName: "Bomb Diffuser", promptText: "Defuse it. Keep tapping." }),
  makeDefaultPenalty({ penaltyId: "stack-overflow", displayName: "Stack Overflow", promptText: "Sort the junk. Tap to clear." }),
];

export function listPenalties() {
  return PENALTIES;
}

export function getPenalty(penaltyId) {
  return PENALTIES.find((penalty) => penalty.penaltyId === penaltyId) || PENALTIES[0];
}

// Weighted pick. `random` is a () => [0,1) function so the caller controls the seed.
export function pickPenalty(random) {
  const total = PENALTIES.reduce((sum, penalty) => sum + (penalty.weight || 1), 0);
  let roll = random() * total;
  for (const penalty of PENALTIES) {
    roll -= penalty.weight || 1;
    if (roll <= 0) return penalty;
  }
  return PENALTIES[0];
}
