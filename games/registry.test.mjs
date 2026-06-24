import {
  lobbyGame,
  matchmakingStrategy,
  matchSettings,
} from "./registry.mjs";

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

console.log("\ngame registry");

test("matchmakingStrategy resolves per-game strategies and a default", () => {
  const cb = matchmakingStrategy("creature-battler-fire");
  assertEq(cb.strategy, "symmetric-balanced");
  assertEq(cb.sides.join(","), "alpha,beta");

  assertEq(matchmakingStrategy("cockpit-swarm").strategy, "symmetric-balanced");
  assertEq(matchmakingStrategy("cockpit-swarm-ranked").sides.join(","), "p1,p2");

  assertEq(matchmakingStrategy("echo-duel").strategy, "lobby");

  // mini-tactics: symmetric seats, so the relay auto-balances p1/p2 like cockpit
  assertEq(matchmakingStrategy("mini-tactics").strategy, "symmetric-balanced");
  assertEq(matchmakingStrategy("mini-tactics").sides.join(","), "p1,p2");

  // unknown gameId -> default side-pair relay
  assertEq(matchmakingStrategy("lovers-lost").strategy, "side-pair");
  assertEq(matchmakingStrategy("totally-new-game").strategy, "side-pair");
});

test("matchSettings is server-owned for Sumorai (incl. -ranked) and null otherwise", () => {
  const s = matchSettings("sumorai", 12345);
  assertEq(s.rulesVersion, "sumorai-online-v1");
  assertEq(s.roundTarget, 3);
  assertEq(s.seed, 12345);
  assertEq(s.stagePlan.length, 5);
  assertEq(s.stagePlan[0], "battlefield");

  assert(matchSettings("sumorai-ranked", 1) !== null, "sumorai-ranked should have settings");
  assertEq(matchSettings("lovers-lost", 12345), null);
  assertEq(matchSettings("creature-battler-fire", 1), null);
});

test("matchSettings hands mini-tactics a shared deterministic seed", () => {
  const s = matchSettings("mini-tactics", 98765);
  assertEq(s.rulesVersion, "mini-tactics-online-v1");
  assertEq(s.seed, 98765);
  // board size is a host choice broadcast in-band, never derived from the seed
  assertEq(s.size, undefined);
});

test("lobbyGame resolves lobby-based games and is null for the rest", () => {
  assert(lobbyGame("echo-duel"), "echo-duel should have a lobby game");
  assert(lobbyGame("build-buddy"), "build-buddy should have a lobby game");
  assert(lobbyGame("pot-of-greed"), "pot-of-greed should have a lobby game");
  assertEq(lobbyGame("sumorai"), null);
  assertEq(lobbyGame("nope"), null);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
