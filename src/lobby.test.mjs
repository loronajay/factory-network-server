import {
  isLobbyJoinable,
  canLobbyStart,
  canLobbyOwnerUpdateSettings,
  doesLobbyMatchSearch,
  buildLobbyStartedPayload,
} from "./lobby.mjs";
import { createEchoDuelMatchState } from "../games/echo-duel/server/echo-duel-match-engine.mjs";

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

console.log("\nlobby authority rules");

test("isLobbyJoinable only allows open lobbies below max capacity", () => {
  assertEq(isLobbyJoinable({
    status: "open",
    maxPlayers: 6,
    members: new Set(["c_1", "c_2"]),
  }), true);

  assertEq(isLobbyJoinable({
    status: "countdown",
    maxPlayers: 6,
    members: new Set(["c_1", "c_2"]),
  }), false);

  assertEq(isLobbyJoinable({
    status: "started",
    maxPlayers: 6,
    members: new Set(["c_1", "c_2"]),
  }), false);

  assertEq(isLobbyJoinable({
    status: "open",
    maxPlayers: 2,
    members: new Set(["c_1", "c_2"]),
  }), false);
});

test("canLobbyStart only allows explicit owner-start from an open ready lobby", () => {
  assertEq(canLobbyStart({
    status: "open",
    minPlayers: 2,
    members: new Set(["c_1", "c_2"]),
  }), true);

  assertEq(canLobbyStart({
    status: "open",
    minPlayers: 3,
    members: new Set(["c_1", "c_2"]),
  }), false);

  assertEq(canLobbyStart({
    status: "countdown",
    minPlayers: 2,
    members: new Set(["c_1", "c_2"]),
  }), false);

  assertEq(canLobbyStart({
    status: "started",
    minPlayers: 2,
    members: new Set(["c_1", "c_2"]),
  }), false);
});

test("canLobbyOwnerUpdateSettings locks settings once startup or match flow has begun", () => {
  assertEq(canLobbyOwnerUpdateSettings({ status: "open" }), true);
  assertEq(canLobbyOwnerUpdateSettings({ status: "countdown" }), false);
  assertEq(canLobbyOwnerUpdateSettings({ status: "started" }), false);
});

test("doesLobbyMatchSearch requires matching game and compatible player limits", () => {
  const lobby = {
    gameId: "bird-duty",
    status: "open",
    isPrivate: false,
    minPlayers: 2,
    maxPlayers: 2,
    members: new Set(["c_host"]),
  };

  assertEq(doesLobbyMatchSearch(lobby, "bird-duty", { minPlayers: 2, maxPlayers: 2 }), true);
  assertEq(doesLobbyMatchSearch(lobby, "bird-duty", { minPlayers: 4, maxPlayers: 4 }), false);
  assertEq(doesLobbyMatchSearch(lobby, "echo-duel", { minPlayers: 2, maxPlayers: 2 }), false);
});

test("buildLobbyStartedPayload includes authoritative Echo Duel snapshot metadata", () => {
  const echoMatch = createEchoDuelMatchState({
    roomCode: "ECHO7",
    ownerId: "c_host",
    settings: { penaltyWord: "STATIC" },
    members: new Set(["c_host", "c_two"]),
    memberProfiles: new Map([
      ["c_host", { displayName: "Host" }],
      ["c_two", { displayName: "Bravo" }],
    ]),
    seed: 456,
  }, 2000);

  const payload = buildLobbyStartedPayload({
    roomCode: "ECHO7",
    gameId: "echo-duel",
    seed: 456,
    ownerId: "c_host",
    members: new Set(["c_host", "c_two"]),
    settings: { penaltyWord: "STATIC" },
    startAt: 6000,
    echoSyncSeq: 3,
    echoMatch,
  }, 2000, "manual");

  assertEq(payload.event, "lobby_started");
  assertEq(payload.authorityMode, "server");
  assertEq(payload.matchState.network.authorityMode, "server");
  assertEq(payload.matchState.network.syncSeq, 3);
  assertEq(payload.matchState.roomCode, "ECHO7");
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
