import {
  createEchoDuelMatchState,
  applyEchoInputToMatch,
  advanceEchoMatchToTime,
  applyEchoDisconnectToMatch,
  serializeEchoMatchState,
} from "./server/echo-duel-match-engine.mjs";
import { echoDuelLobbyGame } from "./server/echo-duel-lobby-game.mjs";

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

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `expected ${JSON.stringify(actual)} === ${JSON.stringify(expected)}`);
  }
}

console.log("\necho duel authority");

test("createEchoDuelMatchState builds an authoritative starting match from lobby members", () => {
  const match = createEchoDuelMatchState({
    roomCode: "ECHO1",
    ownerId: "c_host",
    settings: { penaltyWord: "STATIC" },
    members: new Set(["c_host", "c_two", "c_three"]),
    memberProfiles: new Map([
      ["c_host", { displayName: "Host" }],
      ["c_two", { displayName: "Bravo" }],
      ["c_three", { displayName: "Charlie" }],
    ]),
    seed: 0,
  }, 1000);

  assertEq(match.phase, "owner_create_initial");
  assertEq(match.turnId, 1);
  assertEq(match.phaseId, 1);
  assertEq(match.players.length, 3);
  assertEq(match.players[0].name, "Host");
  assertEq(match.players[1].name, "Bravo");
});

test("driver finishing the initial 4-input pattern transitions to signal playback", () => {
  let match = createEchoDuelMatchState({
    roomCode: "ECHO2",
    ownerId: "c_host",
    settings: { penaltyWord: "STATIC" },
    members: new Set(["c_host", "c_two"]),
    memberProfiles: new Map([
      ["c_host", { displayName: "Host" }],
      ["c_two", { displayName: "Bravo" }],
    ]),
    seed: 0,
  }, 1000);

  match = applyEchoInputToMatch(match, "c_host", "W", { turnId: 1, phaseId: 1 }, 1000);
  match = applyEchoInputToMatch(match, "c_host", "A", { turnId: 1, phaseId: 1 }, 1001);
  match = applyEchoInputToMatch(match, "c_host", "S", { turnId: 1, phaseId: 1 }, 1002);
  match = applyEchoInputToMatch(match, "c_host", "D", { turnId: 1, phaseId: 1 }, 1003);

  assertEq(match.phase, "signal_playback");
  assertEq(match.activeSequence.join(""), "WASD");
  assert(match.playback, "expected playback metadata");
});

test("authoritative Echo Duel inputs are ignored before the scheduled match start time", () => {
  let match = createEchoDuelMatchState({
    roomCode: "ECHO2B",
    ownerId: "c_host",
    settings: { penaltyWord: "STATIC" },
    members: new Set(["c_host", "c_two"]),
    memberProfiles: new Map([
      ["c_host", { displayName: "Host" }],
      ["c_two", { displayName: "Bravo" }],
    ]),
    seed: 0,
  }, 5000);

  match = applyEchoInputToMatch(match, "c_host", "W", { turnId: 1, phaseId: 1, inputId: 1 }, 1000);

  assertEq(match.phase, "owner_create_initial");
  assertEq(match.ownerDraft.length, 0);
});

test("advanceEchoMatchToTime moves finished playback into challenger copy", () => {
  let match = createEchoDuelMatchState({
    roomCode: "ECHO3",
    ownerId: "c_host",
    settings: { penaltyWord: "STATIC" },
    members: new Set(["c_host", "c_two"]),
    memberProfiles: new Map([
      ["c_host", { displayName: "Host" }],
      ["c_two", { displayName: "Bravo" }],
    ]),
    seed: 0,
  }, 1000);

  match = applyEchoInputToMatch(match, "c_host", "W", { turnId: 1, phaseId: 1 }, 1000);
  match = applyEchoInputToMatch(match, "c_host", "A", { turnId: 1, phaseId: 1 }, 1001);
  match = applyEchoInputToMatch(match, "c_host", "S", { turnId: 1, phaseId: 1 }, 1002);
  match = applyEchoInputToMatch(match, "c_host", "D", { turnId: 1, phaseId: 1 }, 1003);

  const advanced = advanceEchoMatchToTime(match, match.playback.endsAt + 1);

  assertEq(advanced.phase, "challenger_copy");
  assert(advanced.copyProgress["c_two"], "expected challenger copy progress");
});

test("challenger failure awards a letter and resets control to the same driver", () => {
  let match = createEchoDuelMatchState({
    roomCode: "ECHO4",
    ownerId: "c_host",
    settings: { penaltyWord: "STATIC" },
    members: new Set(["c_host", "c_two"]),
    memberProfiles: new Map([
      ["c_host", { displayName: "Host" }],
      ["c_two", { displayName: "Bravo" }],
    ]),
    seed: 0,
  }, 1000);

  match = applyEchoInputToMatch(match, "c_host", "W", { turnId: 1, phaseId: 1 }, 1000);
  match = applyEchoInputToMatch(match, "c_host", "A", { turnId: 1, phaseId: 1 }, 1001);
  match = applyEchoInputToMatch(match, "c_host", "S", { turnId: 1, phaseId: 1 }, 1002);
  match = applyEchoInputToMatch(match, "c_host", "D", { turnId: 1, phaseId: 1 }, 1003);
  match = advanceEchoMatchToTime(match, match.playback.endsAt + 1);
  match = applyEchoInputToMatch(match, "c_two", "W", { turnId: match.turnId, phaseId: match.phaseId }, 4000);
  match = applyEchoInputToMatch(match, "c_two", "W", { turnId: match.turnId, phaseId: match.phaseId }, 4001);

  const challenger = match.players.find((player) => player.clientId === "c_two");
  const owner = match.players[match.ownerIndex];

  assertEq(match.phase, "owner_create_initial");
  assertEq(challenger.letters, "S");
  assertEq(owner.clientId, "c_host");
  assertEq(match.turnId, 2);
});

test("duplicate authoritative inputs with the same input id do not double-count", () => {
  let match = createEchoDuelMatchState({
    roomCode: "ECHO4B",
    ownerId: "c_host",
    settings: { penaltyWord: "STATIC" },
    members: new Set(["c_host", "c_two"]),
    memberProfiles: new Map([
      ["c_host", { displayName: "Host" }],
      ["c_two", { displayName: "Bravo" }],
    ]),
    seed: 0,
  }, 1000);

  match = applyEchoInputToMatch(match, "c_host", "W", { turnId: 1, phaseId: 1, inputId: 1 }, 1000);
  match = applyEchoInputToMatch(match, "c_host", "W", { turnId: 1, phaseId: 1, inputId: 1 }, 1001);

  assertEq(match.ownerDraft.join(""), "W");
});

test("1v1 disconnect closes the match without awarding a cheap win", () => {
  const match = createEchoDuelMatchState({
    roomCode: "ECHO5",
    ownerId: "c_host",
    settings: { penaltyWord: "STATIC" },
    members: new Set(["c_host", "c_two"]),
    memberProfiles: new Map([
      ["c_host", { displayName: "Host" }],
      ["c_two", { displayName: "Bravo" }],
    ]),
    seed: 0,
  }, 1000);

  const closed = applyEchoDisconnectToMatch(match, "c_two", 2000);

  assertEq(closed.phase, "match_over");
  assertEq(closed.winnerId, null);
  assert(closed.status.includes("closed"), "expected disconnect close message");
});

test("driver disconnect in 3-player matches passes control to the next active player in turn order", () => {
  const match = createEchoDuelMatchState({
    roomCode: "ECHO5B",
    ownerId: "c_host",
    settings: { penaltyWord: "STATIC" },
    members: new Set(["c_one", "c_two", "c_three"]),
    memberProfiles: new Map([
      ["c_one", { displayName: "Alpha" }],
      ["c_two", { displayName: "Bravo" }],
      ["c_three", { displayName: "Charlie" }],
    ]),
    seed: 1,
  }, 1000);

  const next = applyEchoDisconnectToMatch(match, "c_two", 2000);

  assertEq(next.phase, "owner_create_initial");
  assertEq(next.turnId, 2);
  assertEq(next.players[next.ownerIndex].clientId, "c_three");
});

test("serializeEchoMatchState exposes authority metadata and countdown-friendly remaining time", () => {
  let match = createEchoDuelMatchState({
    roomCode: "ECHO6",
    ownerId: "c_host",
    settings: { penaltyWord: "STATIC" },
    members: new Set(["c_host", "c_two"]),
    memberProfiles: new Map([
      ["c_host", { displayName: "Host" }],
      ["c_two", { displayName: "Bravo" }],
    ]),
    seed: 0,
  }, 1000);

  match = applyEchoInputToMatch(match, "c_host", "W", { turnId: 1, phaseId: 1 }, 1000);
  match = applyEchoInputToMatch(match, "c_host", "A", { turnId: 1, phaseId: 1 }, 1001);
  match = applyEchoInputToMatch(match, "c_host", "S", { turnId: 1, phaseId: 1 }, 1002);
  match = applyEchoInputToMatch(match, "c_host", "D", { turnId: 1, phaseId: 1 }, 1003);

  const snapshot = serializeEchoMatchState(match, {
    roomCode: "ECHO6",
    ownerId: "c_host",
    echoSyncSeq: 7,
  }, 1500);

  assertEq(snapshot.mode, "online");
  assertEq(snapshot.network.authorityMode, "server");
  assertEq(snapshot.network.syncSeq, 7);
  assertEq(snapshot.network.roomCode, "ECHO6");
  assertEq("endsAt" in snapshot.playback, false);
  assert(snapshot.playback.remainingMs > 0, "expected positive playback remaining time");
});

console.log("\necho duel lobby-game adapter");

test("pending Echo Duel starts can be cancelled back to an open lobby before kickoff", () => {
  const lobby = {
    roomCode: "ECHO8",
    gameId: "echo-duel",
    ownerId: "c_host",
    status: "started",
    startAt: 5000,
    seed: 123,
    echoSyncSeq: 9,
    echoMatch: createEchoDuelMatchState({
      roomCode: "ECHO8",
      ownerId: "c_host",
      settings: { penaltyWord: "STATIC" },
      members: new Set(["c_host", "c_two"]),
      memberProfiles: new Map([
        ["c_host", { displayName: "Host" }],
        ["c_two", { displayName: "Bravo" }],
      ]),
      seed: 0,
    }, 5000),
    echoMatchTimer: null,
  };

  assertEq(echoDuelLobbyGame.isMatchPendingStart(lobby, 1000), true);
  echoDuelLobbyGame.cancelPendingStart(lobby);
  assertEq(lobby.status, "open");
  assertEq(lobby.startAt, null);
  assertEq(lobby.seed, null);
  assertEq(lobby.echoSyncSeq, 0);
  assertEq(lobby.echoMatch, null);
});

test("hasActiveMatch reflects whether an authoritative match is live (suppresses the generic post-leave refresh)", () => {
  assertEq(echoDuelLobbyGame.hasActiveMatch({
    echoMatch: { phase: "owner_create_initial" },
    status: "started",
  }), true);

  assertEq(echoDuelLobbyGame.hasActiveMatch({
    echoMatch: null,
    status: "open",
  }), false);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
