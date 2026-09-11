import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createVehicle, stepVehicle } from "./shared/circuit/vehicle.mjs";
import { CIRCUIT_MODELS } from "./shared/circuit/assets.mjs";
import { CIRCUIT_TRACKS, circuitTrackById } from "./shared/circuit/tracks.mjs";
import { createCircuitRace, inputCircuitRace, stepCircuitRace } from "./shared/circuit/race.mjs";
import { loadCircuitRoadMask } from "./shared/circuit-road-mask.mjs";
import {
  CIRCUIT_FLAG_SECONDS,
  MAX_FUTURE_TICKS,
  applyCircuitFlag,
  createAuthoritativeCircuitRound,
} from "./server/speed-demon-circuit-engine.mjs";

const players = [
  { playerId: "p1", displayName: "Ana", modelId: "kaido-gts", livery: { body: "#f00" } },
  { playerId: "p2", displayName: "Bo", modelId: "colt-gt", livery: { body: "#00f" } },
];
const circuitGolden = JSON.parse(fs.readFileSync(new URL("./shared/circuit-golden.json", import.meta.url), "utf8"));

test("the mirrored vehicle matches the committed browser golden replay", () => {
  let vehicle = createVehicle({ x: 610, y: 850, angle: Math.PI / 2 });
  for (let tick = 0; tick < circuitGolden.ticks; tick += 1) {
    vehicle = stepVehicle(vehicle, {
      throttle: tick < 180 ? 1 : 0,
      steer: tick < 80 ? 0.2 : tick < 160 ? -0.15 : 0,
    }, 1 / 120);
  }
  for (const [key, expected] of Object.entries(circuitGolden.vehicle)) {
    assert.ok(Math.abs(vehicle[key] - expected) <= 1e-12, `${key} drifted`);
  }
});

test("the authoritative circuit loads every location mask and the whole cabinet roster", () => {
  assert.deepEqual(CIRCUIT_TRACKS.map((track) => track.id), [
    "old-town-shrine-loop",
    "docklands-freight-loop",
    "downtown-canal-ring",
  ]);
  for (const track of CIRCUIT_TRACKS) {
    const mask = loadCircuitRoadMask(track.id);
    assert.equal(mask.width, 1536);
    assert.equal(mask.height, 1024);
    assert.ok(mask.containsVehicle(createVehicle(track.spawns[0])), `${track.id} spawn is off the road`);
  }
  // The roster is the cabinet's, mirrored: a car with a directional atlas there
  // is a car the server lets race. The old hand-kept list of eight refused the
  // other sixteen with "needs a Circuit Race car".
  assert.equal(CIRCUIT_MODELS.length, 24);
  assert.throws(() => createAuthoritativeCircuitRound({
    players: [{ ...players[0], modelId: "not-a-car" }, players[1]], laps: 3,
  }), /CIRCUIT_ATLAS_UNAVAILABLE/);
  assert.doesNotThrow(() => createAuthoritativeCircuitRound({
    players: [{ ...players[0], modelId: "vortex-fd" }, players[1]], laps: 3,
  }));
});

test("every authoritative grid starts both drivers on one fair line", () => {
  for (const track of CIRCUIT_TRACKS) {
    const [first, second] = track.spawns;
    assert.equal(first.x, second.x, `${track.id} gives one driver distance at the start`);
    assert.ok(Math.abs(first.y - second.y) >= 24, `${track.id} grid slots overlap`);
  }
});

for (const trackId of ["docklands-freight-loop", "downtown-canal-ring"]) {
  test(`the authoritative round uses the requested ${trackId} geometry and mask`, () => {
    const round = createAuthoritativeCircuitRound({ players, laps: 3, trackId });
    const snapshot = round.snapshot();
    assert.equal(snapshot.trackId, trackId);
    assert.equal(snapshot.participants[0].vehicle.x, circuitTrackById(trackId).spawns[0].x);
  });
}

test("the round is the cabinet's reducer with the online rules: a simulated tree and no local finish", () => {
  const round = createAuthoritativeCircuitRound({ players, laps: 3, countdownSeconds: 3 });
  assert.equal(round.snapshot().status, "countdown");
  assert.equal(round.snapshot().countdown, 3);
  const snapshot = round.advance(360);
  assert.ok(["countdown", "racing"].includes(snapshot.status));
  assert.equal(round.advance(362).status, "racing");
  assert.deepEqual(Object.keys(snapshot.participants[0]).sort(), [
    "bestLapTime", "checkpointsPassed", "finishedAt", "input", "lap", "lapStartedAt",
    "lapTimes", "lastLapTime", "nextCheckpoint", "place", "playerId", "vehicle",
  ]);
});

test("tick-stamped steering, throttle, brake and shift are accepted and server-stepped", () => {
  const round = createAuthoritativeCircuitRound({ players, laps: 3, countdownSeconds: 0 });
  const result = round.receive("p1", [{ t: 0, throttle: 1, brake: 0, steer: 0.2, shift: 1 }]);
  assert.equal(result.accepted.length, 1);
  const snapshot = round.advance(120);
  assert.equal(snapshot.tick, 120);
  assert.ok(snapshot.participants[0].vehicle.x > 610);
  assert.deepEqual(Object.keys(snapshot.participants[0].input).sort(), ["brake", "shift", "steer", "throttle"]);
});

test("a late input is applied at the tick the sim is on rather than thrown away", () => {
  // The old engine dropped anything for a tick it had passed, so the server
  // held a stale input until the next packet and every steer change became a
  // correction on the client. A late input is still what the driver's hands
  // are doing now.
  const round = createAuthoritativeCircuitRound({ players, laps: 3, countdownSeconds: 0 });
  round.advance(20);
  const result = round.receive("p1", [
    { t: 1, throttle: 1 },
    { t: 500, throttle: 1 },
    { t: 21, throttle: 1 },
  ]);
  assert.deepEqual(result.accepted.map((event) => event.t), [20, 21]);
  assert.equal(result.rejected, 1, "an input from the far future is still refused");
  const before = round.snapshot().participants[0].vehicle.x;
  round.advance(21);
  assert.notEqual(round.snapshot().participants[0].vehicle.x, before, "the late throttle moved the car on tick 20");
});

test("two late inputs collapsing onto one tick keep the driver's most recent intent", () => {
  const round = createAuthoritativeCircuitRound({ players, laps: 3, countdownSeconds: 0 });
  round.advance(40);
  round.receive("p1", [{ t: 30, steer: -1 }, { t: 35, steer: 1 }]);
  round.receive("p1", [{ t: 32, steer: -1 }]);
  round.advance(41);
  assert.equal(round.snapshot().participants[0].input.steer, 1);
});

test("an input claiming a tick beyond the future window is refused", () => {
  const round = createAuthoritativeCircuitRound({ players, laps: 3, countdownSeconds: 0 });
  const result = round.receive("p1", [{ t: MAX_FUTURE_TICKS, throttle: 1 }, { t: MAX_FUTURE_TICKS + 1, throttle: 1 }]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected, 1);
});

test("the server's race is bit-identical to a client running the same definition and inputs", () => {
  // The whole reason the physics is mirrored rather than re-implemented. A
  // client predicting this round replays exactly this, and if the two ever
  // disagreed the snapshot would snap the car on every corner.
  const trackId = "old-town-shrine-loop";
  const track = circuitTrackById(trackId);
  const mask = loadCircuitRoadMask(trackId);
  const round = createAuthoritativeCircuitRound({ players, laps: 3, trackId, countdownSeconds: 0 });
  let client = createCircuitRace({
    runtime: "circuit", modeId: "circuit", trackId,
    rules: { laps: 3, countdownSeconds: 0, timeoutSeconds: 300, finishRule: "all" },
    participants: players.map((player, index) => ({ ...player, control: index === 0 ? "local" : "remote" })),
    source: { kind: "online", id: null },
  }, track);
  const environment = { track, containsVehicle: (vehicle) => mask.containsVehicle(vehicle) };
  const controls = (tick, id) => ({ throttle: 1, brake: 0, steer: id === "p1" ? Math.sin(tick / 40) : Math.sin(tick / 25 + 1), shift: 0 });
  // Twenty seconds of both cars scraping walls and each other, in packets of
  // uneven length, some arriving late.
  const totalTicks = 120 * 20;
  let sent = 0;
  for (let tick = 0; tick < totalTicks; tick += 1) {
    for (const id of ["p1", "p2"]) client = inputCircuitRace(client, { playerId: id, ...controls(tick, id) });
    client = stepCircuitRace(client, 1 / 120, environment);
    if (tick % 7 === 0 || tick === totalTicks - 1) {
      for (const id of ["p1", "p2"]) {
        round.receive(id, Array.from({ length: tick + 1 - sent }, (_, offset) => ({ t: sent + offset, ...controls(sent + offset, id) })));
      }
      sent = tick + 1;
      round.advance(Math.max(0, tick - 3));
    }
  }
  const server = round.advance(totalTicks);
  assert.equal(server.tick, client.tick);
  for (let index = 0; index < 2; index += 1) {
    assert.deepEqual(server.participants[index].vehicle, client.participants[index].vehicle);
    assert.equal(server.participants[index].lap, client.participants[index].lap);
    assert.equal(server.participants[index].nextCheckpoint, client.participants[index].nextCheckpoint);
  }
});

test("the flag falls a fixed time after the first finisher rather than at the five-minute timeout", () => {
  const home = { playerId: "p1", finishedAt: 40, place: 1 };
  const out = { playerId: "p2", finishedAt: null, place: null };
  const racing = { status: "racing", elapsed: 50, finishOrder: ["p1"], participants: [home, out] };
  assert.equal(applyCircuitFlag(racing).status, "racing", "the other driver still has time");
  assert.equal(applyCircuitFlag({ ...racing, elapsed: 40 + CIRCUIT_FLAG_SECONDS }).status, "finished");
  assert.equal(applyCircuitFlag({ ...racing, finishOrder: [], participants: [out, out] }).status, "racing");
  const done = { ...racing, status: "finished" };
  assert.equal(applyCircuitFlag(done), done);
});
