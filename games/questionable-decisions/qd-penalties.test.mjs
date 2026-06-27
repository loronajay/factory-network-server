import assert from "node:assert/strict";
import test from "node:test";
import { listPenalties, getPenalty, pickPenalty } from "./server/qd-penalties/registry.mjs";
import { makeDefaultPenalty } from "./server/qd-penalties/default.mjs";
import { patternPanicPenalty, PATTERN_PANIC_TARGETS } from "./server/qd-penalties/pattern-panic.mjs";

test("the registry indexes penalties and a seeded pick is deterministic", () => {
  const ids = listPenalties().map((penalty) => penalty.penaltyId);
  assert.ok(ids.includes("pattern-panic"));
  assert.ok(ids.includes("cabinet-says"));
  assert.equal(getPenalty("pattern-panic").penaltyId, "pattern-panic");
  assert.equal(getPenalty("not-real").penaltyId, listPenalties()[0].penaltyId); // safe fallback

  const fixed = () => 0; // always rolls the first weighted entry
  assert.equal(pickPenalty(fixed).penaltyId, listPenalties()[0].penaltyId);

  // Every registered penalty honors the module interface.
  for (const penalty of listPenalties()) {
    for (const method of ["init", "input", "status", "resolve", "serializePublic", "serializePrivate"]) {
      assert.equal(typeof penalty[method], "function", `${penalty.penaltyId} must implement ${method}`);
    }
  }
});

test("default penalty: any input is a hit; clearing avoids loss, ignoring it costs the cap", () => {
  const penalty = makeDefaultPenalty({ penaltyId: "x", displayName: "X" });
  let state = penalty.init({ sourceValue: 200, maxLoss: 300 });
  assert.equal(state.required, 5);

  // No inputs -> full (capped) loss.
  assert.equal(penalty.resolve(state, { maxLoss: 300 }).pointsLost, 300);

  for (let i = 0; i < state.required; i += 1) state = penalty.input(state);
  assert.equal(state.hits, state.required);
  state = penalty.input(state); // beyond requirement is ignored
  assert.equal(state.hits, state.required);
  assert.equal(penalty.resolve(state, { maxLoss: 300 }).pointsLost, 0);
});

test("pattern panic: only the lit face counts; the lit button is exposed to the controller", () => {
  let state = patternPanicPenalty.init({ sourceValue: 100, maxLoss: 150, seed: 42 });
  assert.equal(state.required, 6);
  assert.equal(state.sequence.length, 6);
  assert.ok(state.sequence.every((target) => PATTERN_PANIC_TARGETS.includes(target)));

  // The controller is told exactly which button is lit; the display shows it too.
  assert.deepEqual(patternPanicPenalty.serializePrivate(state).litButtons, [state.sequence[0]]);
  assert.equal(patternPanicPenalty.serializePublic(state).target, state.sequence[0]);

  // A wrong face is a miss (no progress); the correct lit face advances.
  const wrong = PATTERN_PANIC_TARGETS.find((target) => target !== state.sequence[0]);
  let missed = patternPanicPenalty.input(state, wrong);
  assert.equal(missed.index, 0);
  assert.equal(missed.misses, 1);

  // d-pad / shoulder presses are ignored entirely.
  assert.equal(patternPanicPenalty.input(state, "Up").index, 0);

  for (const target of state.sequence) state = patternPanicPenalty.input(state, target);
  assert.equal(state.hits, state.required);
  assert.equal(patternPanicPenalty.serializePrivate(state).litButtons.length, 0); // nothing left to press
  assert.equal(patternPanicPenalty.resolve(state, { maxLoss: 150 }).pointsLost, 0);
});
