import {
  isLobbyJoinable,
  canLobbyStart,
  canLobbyOwnerUpdateSettings,
  doesLobbyMatchSearch,
  buildLobbyStartedPayload,
  buildLobbyPayload,
} from "./lobby.mjs";
import { createEchoDuelMatchState } from "../games/echo-duel/server/echo-duel-match-engine.mjs";
import { createPotOfGreedMatchState } from "../games/pot-of-greed/server/pot-of-greed-match-engine.mjs";
import { lobbies, clientLobbies, clientDisplayLobbies, clientSessionTokens, suspendedLobbySessions } from "./state.mjs";
import { createLobby, suspendLobbyClient, resumeLobbyClient } from "./lobby.mjs";

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

test("Pot of Greed lobby requirements prevent an underfilled game from starting", () => {
  assertEq(canLobbyStart({
    gameId: "pot-of-greed",
    status: "open",
    minPlayers: 2,
    maxPlayers: 8,
    members: new Set(["c_1", "c_2", "c_3"]),
  }), false);

  assertEq(canLobbyStart({
    gameId: "pot-of-greed",
    status: "open",
    minPlayers: 4,
    maxPlayers: 8,
    members: new Set(["c_1", "c_2", "c_3", "c_4"]),
  }), true);
});

test("a Pot of Greed player can resume their locked roster seat within the reconnect window", () => {
  const memberIds = ["c_alex", "c_morgan", "c_riley", "c_jordan"];
  const lobby = {
    roomCode: "GREED",
    gameId: "pot-of-greed",
    ownerId: "c_alex",
    status: "started",
    members: new Set(memberIds),
    memberProfiles: new Map(memberIds.map((id) => [id, { displayName: id }])),
    potOfGreedMatch: null,
  };
  lobby.potOfGreedMatch = createPotOfGreedMatchState(lobby, 1000);
  lobbies.set(lobby.roomCode, lobby);
  for (const id of memberIds) clientLobbies.set(id, lobby.roomCode);
  clientSessionTokens.set("c_morgan", "resume-secret");

  try {
    assertEq(suspendLobbyClient("c_morgan", "disconnect", 2000), true);
    assertEq(lobby.members.has("c_morgan"), true);
    assertEq(lobby.potOfGreedMatch.players.find((player) => player.id === "c_morgan").connected, false);
    assertEq(suspendedLobbySessions.has("c_morgan"), true);

    assertEq(resumeLobbyClient("c_temporary", "c_morgan", "resume-secret", 2500)?.roomCode, "GREED");
    assertEq(lobby.potOfGreedMatch.players.find((player) => player.id === "c_morgan").connected, true);
    assertEq(suspendedLobbySessions.has("c_morgan"), false);
  } finally {
    const suspended = suspendedLobbySessions.get("c_morgan");
    if (suspended?.timer) clearTimeout(suspended.timer);
    lobbies.delete(lobby.roomCode);
    for (const id of memberIds) clientLobbies.delete(id);
    clientSessionTokens.delete("c_morgan");
    suspendedLobbySessions.delete("c_morgan");
  }
});

test("a display-created Pot of Greed room does not consume a player seat", () => {
  const displayId = "c_display";
  const lobby = createLobby(displayId, { gameId: "pot-of-greed", identity: { displayName: "Main Screen" } }, { isPrivate: true, displayOnly: true });
  try {
    assertEq(lobby.displayClientId, displayId);
    assertEq(lobby.members.size, 0);
    assertEq(clientDisplayLobbies.get(displayId), lobby.roomCode);
    assertEq(clientLobbies.has(displayId), false);
    assertEq(lobby.minPlayers, 4);
    assertEq(lobby.maxPlayers, 8);
  } finally {
    lobbies.delete(lobby.roomCode);
    clientDisplayLobbies.delete(displayId);
  }
});

test("lobby snapshots expose the joined player roster to the shared display", () => {
  const payload = buildLobbyPayload({
    roomCode: "ROSTER",
    gameId: "pot-of-greed",
    ownerId: "c_display",
    displayClientId: "c_display",
    members: new Set(["c_alex", "c_morgan"]),
    memberProfiles: new Map([
      ["c_alex", { displayName: "Alex" }],
      ["c_morgan", { displayName: "Morgan" }],
    ]),
    minPlayers: 4,
    maxPlayers: 8,
    status: "open",
    isPrivate: true,
    settings: {},
    startAt: null,
  });
  assertEq(payload.players[0].name, "Alex");
  assertEq(payload.players[1].name, "Morgan");
  assertEq(payload.displayClientId, "c_display");
});

test("lobby snapshots carry the game module's public per-player fields without letting them rewrite identity", () => {
  const payload = buildLobbyPayload({
    roomCode: "COSMET",
    gameId: "pot-of-greed",
    ownerId: "c_alex",
    members: new Set(["c_alex", "c_morgan"]),
    memberProfiles: new Map([
      ["c_alex", { displayName: "Alex" }],
      ["c_morgan", { displayName: "Morgan" }],
    ]),
    publicPlayerFields: new Map([
      ["c_alex", { look: "gold", id: "spoofed", name: "Impostor" }],
    ]),
    minPlayers: 2,
    maxPlayers: 2,
    status: "open",
    isPrivate: false,
    settings: {},
    startAt: null,
  });
  assertEq(payload.players[0].look, "gold");
  assertEq(payload.players[0].id, "c_alex");
  assertEq(payload.players[0].name, "Alex");
  assertEq(payload.players[1].look, undefined);
});

test("canLobbyOwnerUpdateSettings locks settings once startup or match flow has begun", () => {
  assertEq(canLobbyOwnerUpdateSettings({ status: "open" }), true);
  assertEq(canLobbyOwnerUpdateSettings({ status: "countdown" }), false);
  assertEq(canLobbyOwnerUpdateSettings({ status: "started" }), false);
});

test("doesLobbyMatchSearch requires matching game, limits, and queued settings", () => {
  const lobby = {
    gameId: "bird-duty",
    status: "open",
    isPrivate: false,
    minPlayers: 2,
    maxPlayers: 2,
    settings: { matchType: "duel" },
    members: new Set(["c_host"]),
  };

  assertEq(doesLobbyMatchSearch(lobby, "bird-duty", { minPlayers: 2, maxPlayers: 2 }, { matchType: "duel" }), true);
  assertEq(doesLobbyMatchSearch(lobby, "bird-duty", { minPlayers: 2, maxPlayers: 2 }, { matchType: "teams4" }), false);
  assertEq(doesLobbyMatchSearch(lobby, "bird-duty", { minPlayers: 4, maxPlayers: 4 }), false);
  assertEq(doesLobbyMatchSearch(lobby, "echo-duel", { minPlayers: 2, maxPlayers: 2 }), false);
});

test("a ranked search never joins a casual queue, and a game that omits stakes is unaffected", () => {
  const limits = { minPlayers: 2, maxPlayers: 2 };
  const casualLobby = {
    gameId: "yam-bowling",
    status: "open",
    isPrivate: false,
    minPlayers: 2,
    maxPlayers: 2,
    settings: { matchType: "quick", ranked: false },
    members: new Set(["c_host"]),
  };
  const rankedLobby = { ...casualLobby, settings: { matchType: "quick", ranked: true } };

  assertEq(doesLobbyMatchSearch(casualLobby, "yam-bowling", limits, { matchType: "quick", ranked: false }), true);
  assertEq(doesLobbyMatchSearch(casualLobby, "yam-bowling", limits, { matchType: "quick", ranked: true }), false);
  assertEq(doesLobbyMatchSearch(rankedLobby, "yam-bowling", limits, { matchType: "quick", ranked: false }), false);
  assertEq(doesLobbyMatchSearch(rankedLobby, "yam-bowling", limits, { matchType: "quick", ranked: true }), true);

  // Every other game omits the field entirely: both sides normalize to false and
  // matchmaking behaves exactly as it did before the split existed.
  const legacy = { ...casualLobby, gameId: "bird-duty", settings: { matchType: "duel" } };
  assertEq(doesLobbyMatchSearch(legacy, "bird-duty", limits, { matchType: "duel" }), true);
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
