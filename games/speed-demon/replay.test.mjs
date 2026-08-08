// The server's half of the anti-drift guard.
//
// Speed Demon decides online rounds by replaying each driver's input log
// through this repo's *copy* of the cabinet's physics. The two repos are
// independent — the copy is a copy — and the failure mode of any mirror is
// silent drift: someone retunes the torque curve in the cabinet, this side keeps
// adjudicating on the old one, and it hands rounds to the wrong car while both
// test suites stay green.
//
// So both repos commit the same `golden-run.json` and both replay it. If this
// file fails, the mirror under `shared/` is out of date: re-run
// `node tools/mirror-sim.mjs --golden` in
// javascript-games/games/speed-demon and copy the result across.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CAR, RACE_DISTANCES } from "./shared/constants.mjs";
import { GATE_6_SPEED, createGate } from "./shared/gate.mjs";
import { FINISHED } from "./shared/race.mjs";
import { replayRun } from "./shared/input-log.mjs";

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
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "shared", "golden-run.json"), "utf8"));

console.log("\nspeed-demon — mirrored sim replays the golden run");

const replayFixture = () =>
  replayRun(
    {
      car: DEFAULT_CAR,
      gate: createGate(GATE_6_SPEED),
      distanceMetres: RACE_DISTANCES[fixture.distanceId].metres,
      countdownSeconds: fixture.countdownSeconds,
    },
    { events: fixture.events },
  ).race;

test("the fixture is the shape this test was written for", () => {
  assertEqual(fixture.version, 1, "fixture shape changed — update this test with it");
  assert(fixture.events.length > 0, "a fixture with no inputs proves nothing");
});

test("the golden run finishes in exactly the time the cabinet recorded", () => {
  const race = replayFixture();
  assertEqual(race.phase, FINISHED, "the golden run must reach the line");
  assertEqual(
    race.finishTime,
    fixture.expected.finishTime,
    "the mirror under shared/ has drifted from the cabinet's sim — re-run the cabinet's "
      + "tools/mirror-sim.mjs and copy it across, or this server will decide rounds on "
      + "different physics from the clients playing them",
  );
});

test("distance, top speed and final gear match the cabinet", () => {
  const race = replayFixture();
  assertEqual(race.vehicle.distance, fixture.expected.distance, "distance");
  assertEqual(race.topSpeed, fixture.expected.topSpeed, "top speed");
  assertEqual(race.vehicle.gear, fixture.expected.gear, "final gear");
});

test("the launch grades the same way", () => {
  const race = replayFixture();
  assertEqual(race.reactionTime, fixture.expected.reactionTime, "reaction time");
  assertEqual(race.launchGrade, fixture.expected.launchGrade, "launch grade");
});

test("every shift grades the same way, on all three axes", () => {
  const race = replayFixture();
  assertEqual(race.shifts.length, fixture.expected.shifts.length, "shift count");
  race.shifts.forEach((shift, i) => {
    const expected = fixture.expected.shifts[i];
    assertEqual(shift.grade, expected.grade, `shift ${i} grade`);
    assertEqual(shift.reason, expected.reason, `shift ${i} reason`);
    assertEqual(shift.rpmAtEngage, expected.rpmAtEngage, `shift ${i} rpm at engage`);
    assertEqual(shift.catch?.grade ?? null, expected.catchGrade, `shift ${i} catch grade`);
    assertEqual(shift.catch?.deltaSeconds ?? null, expected.catchDelta, `shift ${i} catch offset`);
  });
});

test("a replay is a function of its inputs, so two adjudications cannot disagree", () => {
  assertEqual(replayFixture().finishTime, replayFixture().finishTime);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
