import {
  createBuildBuddyMatchState,
  applyBuildBuddyInputToMatch,
  applyBuildBuddyStageEventToMatch,
  applyBuildBuddyStageResultToMatch,
  applyBuildBuddyDisconnectToMatch,
  serializeBuildBuddyMatchState,
  serializeBuildBuddyStageStartMessage,
  buildBuddyWorldSyncRoute,
} from "./server/build-buddy-match-engine.mjs";
import { buildBuddyLobbyGame } from "./server/build-buddy-lobby-game.mjs";
import { clients, lobbies } from "../../src/state.mjs";

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

test("Build Buddy server accepts a builder recall as a command rather than a nameless place", () => {
  const match = createBuildBuddyMatchState({
    roomCode: "BUDDY5",
    ownerId: "c_host",
    settings: { packId: "pack_01" },
    members: new Set(["c_host", "c_guest"]),
    seed: 123,
  }, 1000);

  const recalled = applyBuildBuddyInputToMatch(match, "c_guest", {
    messageType: "builder_command",
    value: JSON.stringify({ tick: 4, action: "recall", commandId: "cmd_4_recall" }),
  }, 1010);

  assertEq(recalled.rejections.length, 0);
  assertEq(recalled.builderCommands.length, 1);
  assertEq(recalled.builderCommands[0].action, "recall");
  assertEq(recalled.builderCommands[0].toolType, null);
  assertEq(recalled.builderCommands[0].commandId, "cmd_4_recall");
});

test("Build Buddy world sync is relayed only from the current Runner while the stage is live", () => {
  const match = createBuildBuddyMatchState({
    roomCode: "BUDDY6",
    ownerId: "c_host",
    settings: { packId: "pack_01" },
    members: new Set(["c_host", "c_guest"]),
    seed: 123,
  }, 1000);

  // Stage 1: c_host runs, c_guest builds.
  assertEq(buildBuddyWorldSyncRoute(match, "c_host", "state_sync"), "relay");
  assertEq(buildBuddyWorldSyncRoute(match, "c_guest", "state_sync"), "drop");
  assertEq(buildBuddyWorldSyncRoute(match, "c_guest", "builder_cursor"), "relay");
  assertEq(buildBuddyWorldSyncRoute(match, "c_host", "builder_cursor"), "drop");
  assertEq(buildBuddyWorldSyncRoute(match, "c_host", "stage_result"), "reject");

  // Stage 2 swaps the chairs, and so does the relay gate.
  const swapped = applyBuildBuddyStageResultToMatch(match, { outcome: "clear", elapsedMs: 5000 }, 2000);
  assertEq(buildBuddyWorldSyncRoute(swapped, "c_guest", "state_sync"), "relay");
  assertEq(buildBuddyWorldSyncRoute(swapped, "c_host", "state_sync"), "drop");

  // A finished run relays nothing.
  const closed = applyBuildBuddyDisconnectToMatch(swapped, "c_host", 3000);
  assertEq(buildBuddyWorldSyncRoute(closed, "c_guest", "state_sync"), "drop");
  assertEq(buildBuddyWorldSyncRoute(null, "c_guest", "state_sync"), "drop");
});

test("Build Buddy lobby adapter relays the Runner's world sync to the Builder and drops the Builder's", () => {
  const sent = [];
  const fakeSocket = (id) => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, send: (raw) => sent.push({ to: id, data: JSON.parse(raw) }) });
  clients.set("c_host", fakeSocket("c_host"));
  clients.set("c_guest", fakeSocket("c_guest"));
  const lobby = {
    roomCode: "BUDDY7",
    gameId: "build-buddy",
    ownerId: "c_host",
    settings: { packId: "pack_01" },
    members: new Set(["c_host", "c_guest"]),
    seed: 1,
    status: "started",
  };
  lobbies.set("BUDDY7", lobby);
  try {
    buildBuddyLobbyGame.initMatch(lobby, 1000);
    const payload = JSON.stringify({ tick: 9, runner: { x: 10, y: 20 }, tools: [], timerMs: 1234 });

    const fromRunner = buildBuddyLobbyGame.handleMessage(lobby, "c_host", "state_sync", payload);
    assertEq(fromRunner.handled, true);
    assertEq(fromRunner.error, undefined);
    assertEq(sent.length, 1, "runner sync goes to exactly one client");
    assertEq(sent[0].to, "c_guest");
    assertEq(sent[0].data.messageType, "state_sync");
    assertEq(sent[0].data.senderId, "c_host");
    assertEq(sent[0].data.value, payload);

    const fromBuilder = buildBuddyLobbyGame.handleMessage(lobby, "c_guest", "state_sync", payload);
    assertEq(fromBuilder.handled, true);
    assertEq(fromBuilder.error, undefined, "a stale-chair sync is dropped without an error");
    assertEq(sent.length, 1, "builder sync is not relayed");

    const resultClaim = buildBuddyLobbyGame.handleMessage(lobby, "c_host", "stage_result", "{}");
    assertEq(resultClaim.error?.code, "SERVER_AUTHORITY");

    const cursorFromRunner = buildBuddyLobbyGame.handleMessage(lobby, "c_host", "builder_cursor", "{}");
    assertEq(cursorFromRunner.handled, true);
    assertEq(sent.length, 1, "a cursor from the runner chair is dropped");
  } finally {
    clients.delete("c_host");
    clients.delete("c_guest");
    lobbies.delete("BUDDY7");
  }
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
