import assert from "node:assert/strict";
import test from "node:test";

import {
  POT_OF_GREED_CONFIG,
  POT_OF_GREED_PHASES,
  createPotOfGreedMatchState,
  submitPotOfGreedVaultAction,
  resolvePotOfGreedVaultActions,
  beginPotOfGreedVote,
  advancePotOfGreedCycle,
  submitPotOfGreedVote,
  resolvePotOfGreedVote,
  serializePotOfGreedPrivateState,
  serializePotOfGreedPublicState,
} from "./server/pot-of-greed-match-engine.mjs";

function makeLobby() {
  return {
    roomCode: "GREED",
    ownerId: "c_alex",
    members: new Set(["c_alex", "c_morgan", "c_riley", "c_jordan"]),
    memberProfiles: new Map([
      ["c_alex", { displayName: "Alex" }],
      ["c_morgan", { displayName: "Morgan" }],
      ["c_riley", { displayName: "Riley" }],
      ["c_jordan", { displayName: "Jordan" }],
    ]),
  };
}

test("a match starts with a hidden cycle, private gold, and a player-scaled vault", () => {
  const match = createPotOfGreedMatchState(makeLobby(), 1000);

  assert.equal(match.phase, POT_OF_GREED_PHASES.HIDDEN_VAULT_ACTION);
  assert.equal(match.cycleNumber, 1);
  assert.equal(match.vaultGold, 4 * POT_OF_GREED_CONFIG.startingVaultGoldPerPlayer);
  assert.deepEqual(match.players.map((player) => player.gold), [20, 20, 20, 20]);
  assert.deepEqual(match.players.map((player) => player.status), ["active", "active", "active", "active"]);
});

test("hidden-cycle investments enter the vault and mature in the following show cycle", () => {
  let match = createPotOfGreedMatchState(makeLobby(), 1000);
  for (const clientId of ["c_alex", "c_morgan", "c_riley", "c_jordan"]) {
    match = submitPotOfGreedVaultAction(match, clientId, clientId === "c_alex" ? { type: "invest", amount: 5 } : { type: "pass" }, 1100);
  }
  match = resolvePotOfGreedVaultActions(match, 2000);

  const alex = match.players.find((player) => player.id === "c_alex");
  assert.equal(alex.gold, 15);
  assert.equal(match.vaultGold, 53);
  assert.deepEqual(alex.pendingInvestments, [{ cost: 5, returnAmount: 11, createdCycle: 1 }]);
  assert.equal(match.phase, POT_OF_GREED_PHASES.HIDDEN_DISCUSSION);
  match = beginPotOfGreedVote(match, 2050);

  for (const voterId of ["c_alex", "c_morgan", "c_riley"]) {
    match = submitPotOfGreedVote(match, voterId, "c_jordan", 2100);
  }
  match = resolvePotOfGreedVote(match, 2200);
  match = advancePotOfGreedCycle(match, 2300);

  assert.equal(match.cycleType, "show");
  assert.equal(match.phase, POT_OF_GREED_PHASES.SHOW_VAULT_ACTION);
  assert.equal(match.players.find((player) => player.id === "c_alex").gold, 24);
});

test("a caught thief is fined, voters are rewarded, and the selected player becomes jury", () => {
  let match = createPotOfGreedMatchState(makeLobby(), 1000);
  for (const clientId of ["c_alex", "c_morgan", "c_riley", "c_jordan"]) {
    match = submitPotOfGreedVaultAction(match, clientId, clientId === "c_alex" ? { type: "steal", amount: 5 } : { type: "pass" }, 1100);
  }
  match = resolvePotOfGreedVaultActions(match, 2000);
  match = beginPotOfGreedVote(match, 2050);
  for (const voterId of ["c_morgan", "c_riley", "c_jordan"]) {
    match = submitPotOfGreedVote(match, voterId, "c_alex", 2100);
  }
  match = resolvePotOfGreedVote(match, 3000);

  const alex = match.players.find((player) => player.id === "c_alex");
  assert.equal(alex.status, "jury");
  assert.equal(alex.gold, 22);
  assert.equal(match.vaultGold, 46);
  assert.deepEqual(match.players.filter((player) => player.id !== "c_alex").map((player) => player.gold), [22, 22, 22]);
});

test("public state never exposes hidden-cycle balances or unannounced vault actions", () => {
  let match = createPotOfGreedMatchState(makeLobby(), 1000);
  match = submitPotOfGreedVaultAction(match, "c_alex", { type: "steal", amount: 8 }, 1100);

  const publicState = serializePotOfGreedPublicState(match);
  const privateState = serializePotOfGreedPrivateState(match, "c_alex");

  assert.equal("gold" in publicState.players[0], false);
  assert.equal("vaultActions" in publicState, false);
  assert.equal(privateState.me.gold, 20);
  assert.equal(privateState.me.submittedAction, true);
});

test("votes cannot bypass the discussion phase", () => {
  let match = createPotOfGreedMatchState(makeLobby(), 1000);
  for (const clientId of ["c_alex", "c_morgan", "c_riley", "c_jordan"]) {
    match = submitPotOfGreedVaultAction(match, clientId, { type: "pass" }, 1100);
  }
  match = resolvePotOfGreedVaultActions(match, 2000);
  const premature = submitPotOfGreedVote(match, "c_alex", "c_morgan", 2100);
  assert.equal(premature, match);
  assert.equal(Object.keys(match.votes).length, 0);
  match = beginPotOfGreedVote(match, 2200);
  assert.equal(submitPotOfGreedVote(match, "c_alex", "c_morgan", 2300).votes.c_alex, "c_morgan");
});

test("a tied vote enters a runoff and a second tie uses the server tie break", () => {
  let match = createPotOfGreedMatchState(makeLobby(), 1000);
  for (const clientId of ["c_alex", "c_morgan", "c_riley", "c_jordan"]) {
    match = submitPotOfGreedVaultAction(match, clientId, { type: "pass" }, 1100);
  }
  match = resolvePotOfGreedVaultActions(match, 2000);
  match = beginPotOfGreedVote(match, 2050);
  for (const [voterId, targetId] of [["c_alex", "c_morgan"], ["c_morgan", "c_riley"], ["c_riley", "c_morgan"], ["c_jordan", "c_riley"]]) {
    match = submitPotOfGreedVote(match, voterId, targetId, 2100);
  }
  match = resolvePotOfGreedVote(match, 2200);
  assert.equal(match.phase, POT_OF_GREED_PHASES.HIDDEN_RUNOFF_VOTE);
  assert.deepEqual(match.runoffTargets, ["c_morgan", "c_riley"]);

  for (const [voterId, targetId] of [["c_alex", "c_morgan"], ["c_morgan", "c_riley"], ["c_riley", "c_morgan"], ["c_jordan", "c_riley"]]) {
    match = submitPotOfGreedVote(match, voterId, targetId, 2300);
  }
  match = resolvePotOfGreedVote(match, 2400);

  assert.equal(match.lastVoteResult.selectedId, "c_morgan");
  assert.equal(match.lastVoteResult.randomTieBreak, true);
});

test("final settlement pays pending investments and names the wealth winner", () => {
  let match = createPotOfGreedMatchState(makeLobby(), 1000);
  match.phase = POT_OF_GREED_PHASES.HIDDEN_VOTE_RESULT;
  match.players[0].status = "jury";
  match.players[0].gold = 25;
  match.players[1].status = "jury";
  match.players[1].gold = 29;
  match.players[2].status = "jury";
  match.players[2].gold = 17;
  match.players[3].status = "jury";
  match.players[3].gold = 20;
  match.players[3].pendingInvestments = [{ cost: 8, returnAmount: 18, createdCycle: 3 }];

  match = advancePotOfGreedCycle(match, 2000);

  assert.equal(match.phase, POT_OF_GREED_PHASES.FINAL_RESULTS);
  assert.equal(match.players[3].gold, 38);
  assert.deepEqual(match.finalResults.winnerIds, ["c_jordan"]);
});
