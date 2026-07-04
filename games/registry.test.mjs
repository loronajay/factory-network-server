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

  // mini-tactics: 2-4 player deterministic-lockstep over the generic lobby relay
  assertEq(matchmakingStrategy("mini-tactics").strategy, "lobby");

  // tactical-arena: 1v1/2v2 deterministic-lockstep, same relay pattern
  assertEq(matchmakingStrategy("tactical-arena").strategy, "lobby");

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

test("mini-tactics has no server-owned matchSettings (lobby seed is server-generated)", () => {
  // The lobby generates its own shared seed (makeMatchSeed) on start, so unlike
  // the old room path mini-tactics no longer needs a matchSettings echo.
  assertEq(matchSettings("mini-tactics", 98765), null);
});

test("lobbyGame resolves lobby-based games and is null for the rest", () => {
  assert(lobbyGame("echo-duel"), "echo-duel should have a lobby game");
  assert(lobbyGame("build-buddy"), "build-buddy should have a lobby game");
  assert(lobbyGame("pot-of-greed"), "pot-of-greed should have a lobby game");
  // mini-tactics is a config-only lobby game: limits but no match logic.
  const mt = lobbyGame("mini-tactics");
  assert(mt, "mini-tactics should have a lobby game");
  assertEq(mt.lobbyLimits.minPlayers, 2);
  assertEq(mt.lobbyLimits.maxPlayers, 4);
  assertEq(typeof mt.handleMessage, "undefined");
  // tactical-arena is a config-only lobby game too, capped at 4 seats.
  const ta = lobbyGame("tactical-arena");
  assert(ta, "tactical-arena should have a lobby game");
  assertEq(ta.lobbyLimits.minPlayers, 2);
  assertEq(ta.lobbyLimits.maxPlayers, 4);
  assertEq(typeof ta.handleMessage, "undefined");
  assertEq(lobbyGame("sumorai"), null);
  assertEq(lobbyGame("nope"), null);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
