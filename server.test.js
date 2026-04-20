const {
  normalizeMatchSide,
  getMatchQueueKey,
  claimQueuedOpponent,
  enqueueMatchClient,
  buildMatchReadyMessages,
  getQueueCountsForGame,
  shouldReceiveQueueStatus,
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

test("accepts boy and girl only", () => {
  assertEq(normalizeMatchSide("boy"), "boy");
  assertEq(normalizeMatchSide("girl"), "girl");
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

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
