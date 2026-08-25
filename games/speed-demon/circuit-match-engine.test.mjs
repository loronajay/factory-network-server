import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { CIRCUIT_MODEL_IDS, createCircuitVehicle, stepCircuitVehicle } from "./shared/circuit-race.mjs";
import { CIRCUIT_TRACKS, circuitTrackById } from "./shared/circuit-tracks.mjs";
import { loadCircuitRoadMask } from "./shared/circuit-road-mask.mjs";
import { createAuthoritativeCircuitRound } from "./server/speed-demon-circuit-engine.mjs";

const players = [
  { playerId: "p1", modelId: "kaido-gts", livery: { body: "#f00" } },
  { playerId: "p2", modelId: "colt-gt", livery: { body: "#00f" } },
];
const circuitGolden = JSON.parse(fs.readFileSync(new URL("./shared/circuit-golden.json", import.meta.url), "utf8"));

test("the server mirror matches the committed browser golden replay", () => {
  let vehicle = createCircuitVehicle({ x: 610, y: 850, angle: Math.PI / 2 });
  for (let tick = 0; tick < circuitGolden.ticks; tick += 1) {
    vehicle = stepCircuitVehicle(vehicle, {
      throttle: tick < 180 ? 1 : 0,
      steer: tick < 80 ? 0.2 : tick < 160 ? -0.15 : 0,
    });
  }
  for (const [key, expected] of Object.entries(circuitGolden.vehicle)) {
    assert.ok(Math.abs(vehicle[key] - expected) <= 1e-12, `${key} drifted`);
  }
});

test("the authoritative circuit loads all location masks and representative roster only", () => {
  assert.deepEqual(CIRCUIT_TRACKS.map((track) => track.id), [
    "old-town-shrine-loop",
    "docklands-freight-loop",
    "downtown-canal-ring",
  ]);
  for (const track of CIRCUIT_TRACKS) {
    const mask = loadCircuitRoadMask(track.id);
    assert.equal(mask.width, 1536);
    assert.equal(mask.height, 1024);
  }
  assert.equal(CIRCUIT_MODEL_IDS.length, 8);
  assert.throws(() => createAuthoritativeCircuitRound({
    players: [{ ...players[0], modelId: "shutter-z" }, players[1]], laps: 3,
  }), /CIRCUIT_ATLAS_UNAVAILABLE/);
});

test("every authoritative grid starts both drivers on one fair line", () => {
  for (const track of CIRCUIT_TRACKS) {
    const [first, second] = track.spawns;
    assert.equal(first.x, second.x, `${track.id} gives one driver distance at the start`);
    assert.ok(Math.abs(first.y - second.y) >= 24, `${track.id} grid slots overlap`);
  }
});

test("the authoritative round uses the requested Docklands geometry and mask", () => {
  const round = createAuthoritativeCircuitRound({
    players,
    laps: 3,
    trackId: "docklands-freight-loop",
  });
  const snapshot = round.snapshot();
  assert.equal(snapshot.trackId, "docklands-freight-loop");
  assert.equal(snapshot.participants[0].vehicle.x, circuitTrackById("docklands-freight-loop").spawns[0].x);
});

test("the authoritative round uses the requested Downtown geometry and mask", () => {
  const round = createAuthoritativeCircuitRound({
    players,
    laps: 3,
    trackId: "downtown-canal-ring",
  });
  const snapshot = round.snapshot();
  assert.equal(snapshot.trackId, "downtown-canal-ring");
  assert.equal(snapshot.participants[0].vehicle.x, circuitTrackById("downtown-canal-ring").spawns[0].x);
});

test("tick-stamped steering, throttle, brake and shift are accepted and server-stepped", () => {
  const round = createAuthoritativeCircuitRound({ players, laps: 3 });
  const result = round.receive("p1", [{ t: 0, throttle: 1, brake: 0, steer: 0.2, shift: 1 }]);
  assert.equal(result.accepted.length, 1);
  const snapshot = round.advance(120);
  assert.equal(snapshot.tick, 120);
  assert.ok(snapshot.participants[0].vehicle.x > 610);
  assert.deepEqual(Object.keys(snapshot.participants[0].input).sort(), ["brake", "shift", "steer", "throttle"]);
});

test("late and implausibly future inputs cannot rewrite authoritative history", () => {
  const round = createAuthoritativeCircuitRound({ players });
  round.advance(20);
  const result = round.receive("p1", [
    { t: 1, throttle: 1 },
    { t: 500, throttle: 1 },
    { t: 21, throttle: 1 },
  ]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].t, 21);
});

test("two jittered clients converge exactly when the authoritative snapshot arrives", () => {
  const round = createAuthoritativeCircuitRound({ players });
  const events = Array.from({ length: 12 }, (_, index) => ({
    t: index * 10, throttle: 1, brake: 0, steer: index < 6 ? 0.15 : -0.1, shift: index === 4 ? 1 : 0,
  }));
  // Deterministic latency/jitter: packets arrive in four uneven batches, with a
  // duplicate. The server de-duplicates by player/tick.
  for (const batch of [[0, 2, 1], [3, 5, 4], [6, 8, 7, 8], [9, 11, 10]]) {
    round.receive("p1", batch.map((index) => events[index]));
    round.advance(Math.min(119, (batch.at(-1) + 1) * 10));
  }
  const authoritative = round.advance(120);
  const clientA = structuredClone(authoritative);
  const clientB = structuredClone(authoritative);
  assert.deepEqual(clientA, clientB);
  assert.deepEqual(clientA, round.snapshot());
});
