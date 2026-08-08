// The Speed Demon room engine: lobby, tree, adjudication, rematch.
//
// The tests that matter most here are the authority ones. A client can send any
// input log it likes, but it cannot report its own finishing time and cannot
// claim inputs the race has not reached yet — those two properties are what make
// the server the thing that decides rounds rather than the thing that tallies
// what clients said about themselves.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COUNTDOWN_SECONDS,
  DEFAULT_CONFIG,
  INPUT_LEAD_TICKS,
  PHASE_LOBBY,
  PHASE_MATCH_OVER,
  PHASE_ROUND_OVER,
  configFromSeed,
  createSpeedDemonMatchEngine,
  normalizeConfig,
} from "./server/speed-demon-match-engine.mjs";
import { EVENT_ROUND_RESTART, EVENT_ROUND_WON, EVENT_MATCH_WON } from "./shared/match.mjs";
import { EVENT_THROTTLE, EVENT_START } from "./shared/input-log.mjs";
import { TICK_HZ } from "./shared/constants.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}: ${error.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "shared", "golden-run.json"), "utf8"));

console.log("\nspeed-demon — match engine");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A clean, fast run: the golden quarter mile. */
const fastRun = () => golden.events.map((event) => ({ ...event }));

/**
 * The same run, but everything after leaving staging happens `ticks` later — a
 * slower reaction and a slower everything. The START event stays put, because
 * moving it would move the race clock with it and produce an identical time.
 */
const slowRun = (ticks = 30) =>
  golden.events.map((event) =>
    event.k === EVENT_START ? { ...event } : { ...event, t: event.t + ticks },
  );

/** A run that touches the throttle during the countdown: a red light. */
const foulRun = (atTick = 60) => [
  { t: 0, k: EVENT_START, v: 0 },
  { t: atTick, k: EVENT_THROTTLE, v: 1 },
  ...golden.events.filter((event) => event.k !== EVENT_START && event.t > atTick).map((e) => ({ ...e })),
];

/** A clock the test drives by hand, so nothing depends on wall time. */
function fakeClock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms) {
      value += ms;
      return value;
    },
    /** Far enough past the green that any tick in a normal run is timely. */
    pastTheRace() {
      value += 60_000;
      return value;
    },
  };
}

/** A room with two drivers in it, ready to start. */
function seatedRoom(config = {}) {
  const clock = fakeClock();
  const engine = createSpeedDemonMatchEngine({ now: clock.now, config });
  engine.assignPlayer({ clientId: "c_1", playerId: "p1", displayName: "Ana", modelId: "kaido-gts" });
  engine.assignPlayer({ clientId: "c_2", playerId: "p2", displayName: "Bo", modelId: "toro-sv" });
  return { engine, clock };
}

/**
 * Runs one whole round: starts the tree, feeds both logs, and adjudicates.
 * `logs` is keyed by clientId.
 */
function runRound(engine, clock, logs) {
  const start = engine.startRound();
  clock.advance(2000);
  engine.markRunning();
  clock.pastTheRace();
  for (const [clientId, events] of Object.entries(logs)) {
    engine.recordInputs(clientId, { round: start.round, attempt: start.attempt, events });
    engine.recordDone(clientId, { round: start.round, attempt: start.attempt });
  }
  return engine.adjudicate();
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

test("two drivers take the two lanes, first in is the host", () => {
  const { engine } = seatedRoom();
  const seats = engine.describe().players;
  assertEqual(seats.length, 2);
  assertEqual(seats[0].lane, 1);
  assertEqual(seats[1].lane, 2);
  assertEqual(engine.hostClientId, "c_1");
});

test("a third driver is turned away rather than silently ignored", () => {
  const { engine } = seatedRoom();
  const result = engine.assignPlayer({ clientId: "c_3", playerId: "p3", displayName: "Cy" });
  assertEqual(result.ok, false);
  assertEqual(result.code, "ROOM_FULL");
  assertEqual(engine.players.length, 2);
});

test("re-seating the same client is a no-op, not a second car", () => {
  const { engine } = seatedRoom();
  engine.assignPlayer({ clientId: "c_1", playerId: "p1", displayName: "Ana" });
  assertEqual(engine.players.length, 2);
});

test("a driver with no name still gets one", () => {
  const engine = createSpeedDemonMatchEngine({ now: () => 0 });
  engine.assignPlayer({ clientId: "c_1", playerId: "p1", displayName: "   " });
  assertEqual(engine.describe().players[0].displayName, "Driver");
});

test("only the host can change the race", () => {
  const { engine } = seatedRoom();
  const byGuest = engine.setConfig("c_2", { distanceId: "mile" });
  assertEqual(byGuest.ok, false);
  assertEqual(byGuest.code, "NOT_HOST");

  const byHost = engine.setConfig("c_1", { distanceId: "mile" });
  assertEqual(byHost.ok, true);
  assertEqual(engine.config.distanceId, "mile");
});

test("the config locks once the match starts", () => {
  const { engine } = seatedRoom();
  engine.startRound();
  const late = engine.setConfig("c_1", { distanceId: "mile" });
  assertEqual(late.ok, false);
  assertEqual(late.code, "MATCH_STARTED");
});

test("an unknown track, distance or length is clamped rather than rejected", () => {
  const config = normalizeConfig({ trackId: "track-zzz", distanceId: "furlong", bestOf: 4 });
  assertEqual(config.trackId, DEFAULT_CONFIG.trackId);
  assertEqual(config.distanceId, DEFAULT_CONFIG.distanceId);
  assertEqual(config.bestOf, DEFAULT_CONFIG.bestOf);
});

test("a quick-search config is derived from the seed, not from either client", () => {
  const a = configFromSeed(12345);
  const b = configFromSeed(12345);
  assertEqual(a.trackId, b.trackId, "the same seed must give the same race");
  assertEqual(a.distanceId, b.distanceId);
  assert(["quarter", "half"].includes(a.distanceId), "search sticks to the competitive lengths");

  // ...and different seeds do move it around.
  const seen = new Set();
  for (let seed = 0; seed < 40; seed += 1) seen.add(configFromSeed(seed).trackId);
  assert(seen.size > 1, "every search match landing on one track would be a bug");
});

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

test("both drivers are given one countdown, starting at one instant", () => {
  const { engine, clock } = seatedRoom();
  const start = engine.startRound();
  assertEqual(start.round, 1);
  assertEqual(start.attempt, 1);
  assertEqual(start.countdownSeconds, COUNTDOWN_SECONDS);
  assert(start.startAt > clock.now(), "the green must be in the future when the message is sent");
  assert(start.serverNow === clock.now(), "and carry the server's clock so clients can align to it");
});

test("starting a round clears the ready flags it was waiting on", () => {
  const { engine } = seatedRoom();
  engine.setReady("c_1");
  engine.setReady("c_2");
  assert(engine.everyoneReady());
  engine.startRound();
  assert(!engine.everyoneReady(), "the next round has to be staged again");
});

// ---------------------------------------------------------------------------
// Adjudication — the authority tests
// ---------------------------------------------------------------------------

test("the faster log takes the round", () => {
  const { engine, clock } = seatedRoom();
  const result = runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) });

  assertEqual(result.outcome.kind, EVENT_ROUND_WON);
  assertEqual(result.score.players[0].wins, 1, "p1 drove the quicker run");
  assertEqual(result.score.players[1].wins, 0);
});

test("the server's finishing times come from its own replay, not from the client", () => {
  const { engine, clock } = seatedRoom();
  const result = runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) });

  const p1 = result.runs.find((run) => run.playerId === "p1");
  assertEqual(
    p1.finishTime,
    golden.expected.finishTime,
    "the winner's time must be the replayed one, to the decimal",
  );
  const p2 = result.runs.find((run) => run.playerId === "p2");
  assert(p2.finishTime > p1.finishTime, "and the slower log must replay slower");
});

test("a client cannot report a time for itself — recordDone carries no result", () => {
  const { engine, clock } = seatedRoom();
  const start = engine.startRound();
  clock.pastTheRace();

  // A client claiming a blistering time while sending a log that never moved.
  engine.recordInputs("c_1", { round: start.round, attempt: start.attempt, events: [] });
  engine.recordDone("c_1", { round: start.round, attempt: start.attempt, finishTime: 0.01, winner: true });
  engine.recordInputs("c_2", { round: start.round, attempt: start.attempt, events: fastRun() });
  engine.recordDone("c_2", { round: start.round, attempt: start.attempt });

  const result = engine.adjudicate();
  const liar = result.runs.find((run) => run.playerId === "p1");
  assertEqual(liar.finishTime, null, "an empty log finishes nowhere, whatever was claimed");
  assertEqual(liar.complete, false);
  assertEqual(result.score.players[1].wins, 1, "the round goes to the driver who actually drove");
});

test("a driver who never crosses loses to one who does", () => {
  const { engine, clock } = seatedRoom();
  const result = runRound(engine, clock, { c_1: [], c_2: fastRun() });
  assertEqual(result.outcome.kind, EVENT_ROUND_WON);
  assertEqual(result.score.players[1].wins, 1);
});

test("inputs claiming a tick the race has not reached are dropped", () => {
  const { engine, clock } = seatedRoom();
  const start = engine.startRound();
  clock.advance(1000); // one second in: about 60 ticks have really elapsed

  const accepted = engine.recordInputs("c_1", {
    round: start.round,
    attempt: start.attempt,
    // One plausible event and one from a run that has not happened yet.
    events: [
      { t: 30, k: EVENT_THROTTLE, v: 1 },
      { t: 5000, k: EVENT_THROTTLE, v: 0 },
    ],
  });
  assertEqual(accepted.accepted.length, 1, "only the timely one lands");
  assertEqual(accepted.rejected, 1, "and the fabricated one is counted out");
});

test("late inputs are still accepted, because that is just the network", () => {
  const { engine, clock } = seatedRoom();
  const start = engine.startRound();
  clock.pastTheRace(); // long after the fact

  const accepted = engine.recordInputs("c_1", {
    round: start.round,
    attempt: start.attempt,
    events: [{ t: 30, k: EVENT_THROTTLE, v: 1 }],
  });
  assertEqual(accepted.accepted.length, 1);
  assertEqual(accepted.rejected, 0);
});

test("the lead allowance is slack for jitter, not a licence to run ahead", () => {
  const { engine, clock } = seatedRoom();
  const start = engine.startRound();
  // Right on the green, so barely any ticks have elapsed.
  const justInside = INPUT_LEAD_TICKS - 5;
  const wayOutside = INPUT_LEAD_TICKS + TICK_HZ * 5;

  const result = engine.recordInputs("c_1", {
    round: start.round,
    attempt: start.attempt,
    events: [
      { t: justInside, k: EVENT_THROTTLE, v: 1 },
      { t: wayOutside, k: EVENT_THROTTLE, v: 0 },
    ],
  });
  assertEqual(result.accepted.length, 1);
  assertEqual(result.rejected, 1);
});

test("inputs for a round that is no longer live are ignored", () => {
  const { engine, clock } = seatedRoom();
  const start = engine.startRound();
  clock.pastTheRace();
  const stale = engine.recordInputs("c_1", {
    round: start.round + 1,
    attempt: 1,
    events: fastRun(),
  });
  assertEqual(stale, null, "a round number that is not the live one is not a valid claim");
});

// ---------------------------------------------------------------------------
// Red lights
// ---------------------------------------------------------------------------

test("a red light is found in the replay, and re-runs the round", () => {
  const { engine, clock } = seatedRoom();
  const result = runRound(engine, clock, { c_1: foulRun(60), c_2: fastRun() });

  assertEqual(result.redLight, true);
  assertEqual(result.outcome.kind, EVENT_ROUND_RESTART, "the first one is only a fault");
  assertEqual(result.offenders.length, 1);
  assertEqual(result.offenders[0].playerId, "p1");
  assertEqual(result.score.players[0].wins, 0, "and nobody takes the round");
  assertEqual(result.score.players[1].wins, 0);
});

test("a red light decides the round before the finishing times are even compared", () => {
  const { engine, clock } = seatedRoom();
  // p1 fouls twice; p2's run is the slower one, and wins anyway.
  runRound(engine, clock, { c_1: foulRun(60), c_2: fastRun() });
  const result = runRound(engine, clock, { c_1: foulRun(60), c_2: slowRun(200) });

  assertEqual(result.outcome.kind, EVENT_ROUND_WON);
  assertEqual(result.score.players[1].wins, 1, "the clean driver takes it however slow they were");
});

test("faults reset when the next round begins", () => {
  const { engine, clock } = seatedRoom();
  runRound(engine, clock, { c_1: foulRun(60), c_2: fastRun() }); // p1 faults, round re-runs
  const won = runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) }); // p1 wins round 1

  assertEqual(won.score.roundNumber, 2, "on to round two");
  assertEqual(won.score.players[0].faults, 0, "with the fault behind them");
});

test("both drivers jumping the same tree burns both graces and re-runs", () => {
  const { engine, clock } = seatedRoom();
  const result = runRound(engine, clock, { c_1: foulRun(60), c_2: foulRun(40) });
  assertEqual(result.outcome.kind, EVENT_ROUND_RESTART);
  assertEqual(result.offenders.length, 2);
  assertEqual(result.score.players[0].faults, 1);
  assertEqual(result.score.players[1].faults, 1);
});

test("when both are out of grace, the driver who left first loses the round", () => {
  const { engine, clock } = seatedRoom();
  runRound(engine, clock, { c_1: foulRun(60), c_2: foulRun(60) }); // both to one fault

  // Jumping at tick 30 leaves more of the tree still to run than jumping at 90,
  // so p1 is the one who went early and p1 takes the red light.
  const result = runRound(engine, clock, { c_1: foulRun(30), c_2: foulRun(90) });

  assertEqual(result.outcome.kind, EVENT_ROUND_WON);
  assertEqual(result.offenders.length, 2, "both jumped");
  const p1Jump = result.offenders.find((offender) => offender.playerId === "p1").jumpedBeforeGreen;
  const p2Jump = result.offenders.find((offender) => offender.playerId === "p2").jumpedBeforeGreen;
  assert(p1Jump > p2Jump, "more tree left means an earlier departure");
  assertEqual(result.score.players[1].wins, 1, "so the round goes to p2");
  assertEqual(result.score.players[0].wins, 0);
});

// ---------------------------------------------------------------------------
// Winning
// ---------------------------------------------------------------------------

test("two rounds wins a best of three, and the match is over", () => {
  const { engine, clock } = seatedRoom();
  runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) });
  const result = runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) });

  assertEqual(result.outcome.kind, EVENT_MATCH_WON);
  assertEqual(result.decided, true);
  assertEqual(result.winnerId, "p1");
  assertEqual(engine.phase, PHASE_MATCH_OVER);
  assertEqual(engine.nextStep(), "match-over");
});

test("nextStep tells the bridge whether to re-run, move on, or stop", () => {
  const { engine, clock } = seatedRoom();
  runRound(engine, clock, { c_1: foulRun(60), c_2: fastRun() });
  assertEqual(engine.nextStep(), "same-round");
  assertEqual(engine.phase, PHASE_ROUND_OVER);

  runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) });
  assertEqual(engine.nextStep(), "next-round");
});

test("a best of one is over after a single round", () => {
  const { engine, clock } = seatedRoom({ bestOf: 1 });
  const result = runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) });
  assertEqual(result.decided, true);
  assertEqual(result.winnerId, "p1");
});

test("a best of five needs three", () => {
  const { engine, clock } = seatedRoom({ bestOf: 5 });
  runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) });
  runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) });
  assertEqual(engine.phase, PHASE_ROUND_OVER, "two of five is not a majority");
  const result = runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) });
  assertEqual(result.decided, true);
});

test("the result carries each driver's launch and shifts for the panel", () => {
  const { engine, clock } = seatedRoom();
  const result = runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) });
  const p1 = result.runs.find((run) => run.playerId === "p1");
  assertEqual(p1.launchGrade, golden.expected.launchGrade);
  assertEqual(p1.reactionTime, golden.expected.reactionTime);
  assertEqual(p1.shifts.length, golden.expected.shifts.length);
  assertEqual(p1.displayName, "Ana");
});

// ---------------------------------------------------------------------------
// Leaving and rematching
// ---------------------------------------------------------------------------

test("a driver leaving mid-match concedes it", () => {
  const { engine, clock } = seatedRoom();
  runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) });
  const left = engine.removePlayer("c_1");

  assertEqual(left.conceded, true);
  assertEqual(left.winnerId, "p2", "there is nobody left to race the rest");
  assertEqual(engine.phase, PHASE_MATCH_OVER);
});

test("a driver leaving the lobby concedes nothing", () => {
  const { engine } = seatedRoom();
  const left = engine.removePlayer("c_2");
  assertEqual(left.conceded, false);
  assertEqual(engine.players.length, 1);
});

test("the host seat passes on when the host leaves the lobby", () => {
  const { engine } = seatedRoom();
  engine.removePlayer("c_1");
  assertEqual(engine.hostClientId, "c_2");
});

test("a rematch needs both drivers to ask", () => {
  const { engine, clock } = seatedRoom();
  runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) });
  runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) });

  const first = engine.requestRematch("c_1");
  assertEqual(first.started, false, "one driver asking is a request, not a restart");
  assertEqual(first.requested.find((entry) => entry.playerId === "p1").requested, true);
  assertEqual(first.requested.find((entry) => entry.playerId === "p2").requested, false);

  const second = engine.requestRematch("c_2");
  assertEqual(second.started, true);
  assertEqual(engine.phase, PHASE_LOBBY, "and the room is back in the lobby");
});

test("a rematch starts a genuinely new match, not a half-reset one", () => {
  const { engine, clock } = seatedRoom();
  runRound(engine, clock, { c_1: foulRun(60), c_2: fastRun() }); // leaves p1 on a fault
  runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) });
  runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) });
  assertEqual(engine.phase, PHASE_MATCH_OVER);

  engine.requestRematch("c_1");
  engine.requestRematch("c_2");
  const start = engine.startRound();

  assertEqual(start.round, 1, "back to round one");
  assertEqual(start.score.players[0].wins, 0, "with the scoreboard cleared");
  assertEqual(start.score.players[0].faults, 0, "and no fault carried over");
});

test("a rematch cannot be asked for mid-match", () => {
  const { engine, clock } = seatedRoom();
  runRound(engine, clock, { c_1: fastRun(), c_2: slowRun(30) });
  assertEqual(engine.requestRematch("c_1").ok, false, "the match is still live");
});

test("a round that nobody reports eventually times out rather than hanging", () => {
  const { engine, clock } = seatedRoom();
  const start = engine.startRound();
  assert(!engine.roundIsOver(), "not over while it is still being run");
  engine.recordDone("c_1", { round: start.round, attempt: start.attempt });
  assert(!engine.roundIsOver(), "still waiting on the other driver");
  clock.advance(120000);
  assert(engine.roundIsOver(), "a driver who vanished must not hang the match forever");
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
