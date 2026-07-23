import {
  createBuildBuddyMatchState,
  applyBuildBuddyInputToMatch,
  applyBuildBuddyStageEventToMatch,
  applyBuildBuddyStageResultToMatch,
  applyBuildBuddyDisconnectToMatch,
  serializeBuildBuddyMatchState,
  serializeBuildBuddyStageStartMessage,
} from "./server/build-buddy-match-engine.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}: ${error.message}`);
    failed++;
  }
}

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `expected ${JSON.stringify(actual)} === ${JSON.stringify(expected)}`);
  }
}

console.log("\nbuild buddy authority");

test("createBuildBuddyMatchState starts a server-authoritative 10-stage run with alternating roles", () => {
  const match = createBuildBuddyMatchState({
    roomCode: "BUDDY1",
    ownerId: "c_host",
    settings: { packId: "pack_01" },
    members: new Set(["c_host", "c_guest"]),
    memberProfiles: new Map([
      ["c_host", { displayName: "Host" }],
      ["c_guest", { displayName: "Guest" }],
    ]),
    seed: 123,
  }, 1000);

  assertEq(match.mode, "online");
  assertEq(match.authorityMode, "server");
  assertEq(match.packId, "pack_01");
  assertEq(match.stageSequence.length, 10);
  assertEq(match.currentStageId, "pack_01_stage_01");
  assertEq(match.roles.runnerPlayerId, "c_host");
  assertEq(match.roles.builderPlayerId, "c_guest");
});

test("Build Buddy server accepts role-appropriate commands and rejects the wrong role", () => {
  let match = createBuildBuddyMatchState({
    roomCode: "BUDDY2",
    ownerId: "c_host",
    settings: { packId: "pack_01" },
    members: new Set(["c_host", "c_guest"]),
    seed: 123,
  }, 1000);

  const runnerApplied = applyBuildBuddyInputToMatch(match, "c_host", {
    messageType: "runner_input",
    value: JSON.stringify({ tick: 1, right: true }),
  }, 1010);
  const wrongBuilder = applyBuildBuddyInputToMatch(runnerApplied, "c_host", {
    messageType: "builder_command",
    value: JSON.stringify({ tick: 2, action: "place", toolType: "platform", gridX: 80, gridY: 120 }),
  }, 1011);
  const builderApplied = applyBuildBuddyInputToMatch(runnerApplied, "c_guest", {
    messageType: "builder_command",
    value: JSON.stringify({ tick: 2, action: "place", toolType: "platform", gridX: 80, gridY: 120 }),
  }, 1012);

  assertEq(runnerApplied.runnerInputs.length, 1);
  assertEq(wrongBuilder.builderCommands.length, 0);
  assertEq(wrongBuilder.rejections.length, 1);
  assertEq(builderApplied.builderCommands.length, 1);
});

test("Build Buddy server owns stage results and swaps roles after clear or timer fail", () => {
  let match = createBuildBuddyMatchState({
    roomCode: "BUDDY3",
    ownerId: "c_host",
    settings: { packId: "pack_01" },
    members: new Set(["c_host", "c_guest"]),
    seed: 123,
  }, 1000);

  match = applyBuildBuddyStageResultToMatch(match, {
    outcome: "clear",
    elapsedMs: 42000,
  }, 5000);
  match = applyBuildBuddyStageResultToMatch(match, {
    outcome: "fail",
    failReason: "timer",
    elapsedMs: 90000,
  }, 95000);

  assertEq(match.stageResults.length, 2);
  assertEq(match.stageResults[0].stageId, "pack_01_stage_01");
  assertEq(match.stageResults[1].failReason, "timer");
  assertEq(match.currentStageId, "pack_01_stage_03");
  assertEq(match.roles.runnerPlayerId, "c_host");
  assertEq(match.roles.builderPlayerId, "c_guest");
});

test("Build Buddy server advances only from role-valid stage completion events", () => {
  const match = createBuildBuddyMatchState({
    roomCode: "BUDDY3B",
    ownerId: "c_host",
    settings: { packId: "pack_01" },
    members: new Set(["c_host", "c_guest"]),
    seed: 123,
  }, 1000);

  const wrongRole = applyBuildBuddyStageEventToMatch(match, "c_guest", {
    messageType: "stage_complete_request",
    value: JSON.stringify({ stageId: "pack_01_stage_01", stageIndex: 0, outcome: "clear", elapsedMs: 1200 }),
  }, 2000);
  const staleStage = applyBuildBuddyStageEventToMatch(match, "c_host", {
    messageType: "stage_complete_request",
    value: JSON.stringify({ stageId: "pack_01_stage_02", stageIndex: 1, outcome: "clear", elapsedMs: 1200 }),
  }, 2000);
  const accepted = applyBuildBuddyStageEventToMatch(match, "c_host", {
    messageType: "stage_complete_request",
    value: JSON.stringify({ stageId: "pack_01_stage_01", stageIndex: 0, outcome: "clear", elapsedMs: 1200 }),
  }, 2000);

  assertEq(wrongRole.stageResults.length, 0);
  assertEq(wrongRole.rejections[0].reason, "wrong_completion_role");
  assertEq(staleStage.stageResults.length, 0);
  assertEq(staleStage.rejections[0].reason, "stage_mismatch");
  assertEq(accepted.stageResults.length, 1);
  assertEq(accepted.currentStageId, "pack_01_stage_02");
});

test("Build Buddy serialization exposes accepted command cursors for client replay", () => {
  let match = createBuildBuddyMatchState({
    roomCode: "BUDDY3C",
    ownerId: "c_host",
    settings: { packId: "pack_01" },
    members: new Set(["c_host", "c_guest"]),
    seed: 123,
  }, 1000);
  match = applyBuildBuddyInputToMatch(match, "c_host", {
    messageType: "runner_input",
    value: JSON.stringify({ tick: 1, right: true }),
  }, 1010);
  match = applyBuildBuddyInputToMatch(match, "c_guest", {
    messageType: "builder_command",
    value: JSON.stringify({ tick: 2, action: "place", toolType: "platform", gridX: 80, gridY: 120 }),
  }, 1012);

  const snapshot = serializeBuildBuddyMatchState(match, { roomCode: "BUDDY3C", buildBuddySyncSeq: 4 }, 1200);

  assertEq(snapshot.commands.runnerInputs.length, 1);
  assertEq(snapshot.commands.builderCommands.length, 1);
  assertEq(snapshot.commands.runnerInputs[0].seq, 1);
  assertEq(snapshot.commands.builderCommands[0].seq, 2);
});

test("Build Buddy match snapshots ship only the command delta above sinceSeq and omit the raw log", () => {
  let match = createBuildBuddyMatchState({
    roomCode: "BUDDY3E",
    ownerId: "c_host",
    settings: { packId: "pack_01" },
    members: new Set(["c_host", "c_guest"]),
    seed: 123,
  }, 1000);
  match = applyBuildBuddyInputToMatch(match, "c_host", {
    messageType: "runner_input",
    value: JSON.stringify({ tick: 1, right: true }),
  }, 1010);
  match = applyBuildBuddyInputToMatch(match, "c_guest", {
    messageType: "builder_command",
    value: JSON.stringify({ tick: 2, action: "place", toolType: "platform", gridX: 80, gridY: 120 }),
  }, 1012);
  match = applyBuildBuddyInputToMatch(match, "c_host", {
    messageType: "runner_input",
    value: JSON.stringify({ tick: 3, left: true }),
  }, 1014);

  // A client that has already applied through seq 2 should receive only seq 3.
  const delta = serializeBuildBuddyMatchState(match, { roomCode: "BUDDY3E" }, 1200, { sinceSeq: 2 });
  assertEq(delta.commands.runnerInputs.length, 1);
  assertEq(delta.commands.builderCommands.length, 0);
  assertEq(delta.commands.runnerInputs[0].seq, 3);

  // The heavy per-command log must not ride along on the wire payload.
  assertEq(delta.runnerInputs, undefined);
  assertEq(delta.builderCommands, undefined);
  assertEq(delta.rejections, undefined);

  // No cursor (full snapshot, e.g. lobby_started) still exposes everything.
  const full = serializeBuildBuddyMatchState(match, { roomCode: "BUDDY3E" }, 1200);
  assertEq(full.commands.runnerInputs.length, 2);
  assertEq(full.commands.builderCommands.length, 1);
});

test("Build Buddy stage_start serialization matches the client stage-start contract", () => {
  let match = createBuildBuddyMatchState({
    roomCode: "BUDDY3D",
    ownerId: "c_host",
    settings: { packId: "pack_01" },
    members: new Set(["c_host", "c_guest"]),
    seed: 123,
  }, 1000);
  match = applyBuildBuddyStageResultToMatch(match, {
    outcome: "clear",
    elapsedMs: 42000,
  }, 5000);

  const stageStart = serializeBuildBuddyStageStartMessage(match, { buildBuddySyncSeq: 5 }, 6200);

  assertEq(stageStart.stageId, "pack_01_stage_02");
  assertEq(stageStart.stageIndex, 1);
  assertEq(stageStart.roles.runnerPlayerId, "c_guest");
  assertEq(stageStart.roles.builderPlayerId, "c_host");
  assertEq(stageStart.authorityPlayerId, "server");
});

test("Build Buddy serialization exposes server authority and disconnect closes the run", () => {
  const match = createBuildBuddyMatchState({
    roomCode: "BUDDY4",
    ownerId: "c_host",
    settings: { packId: "pack_01" },
    members: new Set(["c_host", "c_guest"]),
    seed: 123,
  }, 1000);
  const snapshot = serializeBuildBuddyMatchState(match, { roomCode: "BUDDY4", buildBuddySyncSeq: 7 }, 1200);
  const closed = applyBuildBuddyDisconnectToMatch(match, "c_guest", 2000);

  assertEq(snapshot.network.authorityMode, "server");
  assertEq(snapshot.network.syncSeq, 7);
  assertEq(snapshot.stage.stageId, "pack_01_stage_01");
  assertEq(closed.phase, "match_over");
  assertEq(closed.status, "closed_disconnect");
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
