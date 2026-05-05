const {
  normalizeMatchSide,
  getMatchQueueKey,
  claimQueuedOpponent,
  enqueueMatchClient,
  buildMatchReadyMessages,
  getQueueCountsForGame,
  shouldReceiveQueueStatus,
  isLobbyJoinable,
  canLobbyStart,
  canLobbyOwnerUpdateSettings,
  createEchoDuelMatchState,
  applyEchoInputToMatch,
  advanceEchoMatchToTime,
  applyEchoDisconnectToMatch,
  serializeEchoMatchState,
  buildLobbyStartedPayload,
} = require("./server.js");

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

console.log("\nnormalizeMatchSide");

test("accepts registered side pairs, rejects unknown sides", () => {
  assertEq(normalizeMatchSide("boy"), "boy");
  assertEq(normalizeMatchSide("girl"), "girl");
  assertEq(normalizeMatchSide("alpha"), "alpha");
  assertEq(normalizeMatchSide("beta"), "beta");
  assertEq(normalizeMatchSide("wizard"), null);
  assertEq(normalizeMatchSide(""), null);
});

console.log("\ngetMatchQueueKey");

test("uses legacy per-game queue when no side is supplied", () => {
  assertEq(getMatchQueueKey("lovers-lost", null), "lovers-lost");
});

test("uses per-side queue when a supported side is supplied", () => {
  assertEq(getMatchQueueKey("lovers-lost", "boy"), "lovers-lost:boy");
  assertEq(getMatchQueueKey("lovers-lost", "girl"), "lovers-lost:girl");
});

console.log("\nclaimQueuedOpponent");

test("legacy queueing still pairs same-game requests without a side", () => {
  const queues = new Map([["lovers-lost", ["c_a"]]]);

  const opponentId = claimQueuedOpponent(queues, "lovers-lost", null);

  assertEq(opponentId, "c_a");
  assertEq(queues.has("lovers-lost"), false);
});

test("boy requests claim the front girl opponent", () => {
  const queues = new Map([["lovers-lost:girl", ["c_g1", "c_g2"]]]);

  const opponentId = claimQueuedOpponent(queues, "lovers-lost", "boy");

  assertEq(opponentId, "c_g1");
  assertEq(queues.get("lovers-lost:girl")[0], "c_g2");
});

test("same-side requests do not claim each other", () => {
  const queues = new Map([["lovers-lost:boy", ["c_b1"]]]);

  const opponentId = claimQueuedOpponent(queues, "lovers-lost", "boy");

  assertEq(opponentId, null);
  assertEq(queues.get("lovers-lost:boy")[0], "c_b1");
});

console.log("\nenqueueMatchClient");

test("side-aware queueing appends to the correct side queue", () => {
  const queues = new Map();

  enqueueMatchClient(queues, "lovers-lost", "boy", "c_b1");
  enqueueMatchClient(queues, "lovers-lost", "boy", "c_b2");
  enqueueMatchClient(queues, "lovers-lost", "girl", "c_g1");

  assertEq(queues.get("lovers-lost:boy").length, 2);
  assertEq(queues.get("lovers-lost:boy")[1], "c_b2");
  assertEq(queues.get("lovers-lost:girl")[0], "c_g1");
});

test("legacy queueing still uses the game id key", () => {
  const queues = new Map();

  enqueueMatchClient(queues, "other-game", null, "c_a");

  assertEq(queues.get("other-game")[0], "c_a");
});

console.log("\nqueue status");

test("getQueueCountsForGame reports side-aware queue totals for one game", () => {
  const queues = new Map([
    ["lovers-lost:boy", ["c_b1", "c_b2"]],
    ["lovers-lost:girl", ["c_g1"]],
    ["other-game:boy", ["c_x"]],
  ]);

  const counts = getQueueCountsForGame(queues, "lovers-lost");

  assertEq(counts.boy, 2);
  assertEq(counts.girl, 1);
});

test("getQueueCountsForGame falls back to zero when a side queue is empty or missing", () => {
  const queues = new Map([
    ["lovers-lost:girl", ["c_g1"]],
  ]);

  const counts = getQueueCountsForGame(queues, "lovers-lost");

  assertEq(counts.boy, 0);
  assertEq(counts.girl, 1);
});

test("shouldReceiveQueueStatus only targets clients watching the same game", () => {
  const watchedGames = new Map([
    ["c_watch", "lovers-lost"],
    ["c_other", "bird-duty"],
    ["c_none", null],
  ]);

  assertEq(shouldReceiveQueueStatus(watchedGames, "c_watch", "lovers-lost"), true);
  assertEq(shouldReceiveQueueStatus(watchedGames, "c_other", "lovers-lost"), false);
  assertEq(shouldReceiveQueueStatus(watchedGames, "c_none", "lovers-lost"), false);
});

console.log("\nbuildMatchReadyMessages");

test("builds mirrored match_ready payloads with one shared seed and start time", () => {
  const messages = buildMatchReadyMessages("c_boy", "boy", "c_girl", "girl", 1000, 4000, 12345);

  assertEq(messages.length, 2);
  assertEq(messages[0].payload.event, "match_ready");
  assertEq(messages[1].payload.event, "match_ready");
  assertEq(messages[0].payload.seed, 12345);
  assertEq(messages[1].payload.seed, 12345);
  assertEq(messages[0].payload.startAt, 5000);
  assertEq(messages[1].payload.startAt, 5000);
  assertEq(messages[0].payload.remoteSide, "girl");
  assertEq(messages[1].payload.remoteSide, "boy");
});

test("does not build a match_ready payload when both sides match", () => {
  assertEq(buildMatchReadyMessages("c_one", "boy", "c_two", "boy", 1000, 4000, 12345), null);
});

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
