import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDownsRaceBridge, canonicalJson, signRacePayload, verifyRacePayload } from "./server/downs-race-bridge.mjs";
import { rideProfile } from "./mirror/farm-ride-profile.mjs";
import { packRideInput } from "./mirror/farm-ride.mjs";

// The riding set under ./mirror is a byte-for-byte copy of javascript-games' js/
// files (tools/mirror-riding-sim.mjs there). If the hash test fails, re-run that
// tool and commit both repos.
const here = dirname(fileURLToPath(import.meta.url));
const mirror = join(here, "mirror");
const manifest = JSON.parse(readFileSync(join(mirror, "riding-sim-manifest.json"), "utf8"));
const hash = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

test("every mirrored riding file matches the manifest, and nothing else is in the mirror", () => {
  for (const [name, recorded] of Object.entries(manifest.emitted)) {
    assert.equal(hash(readFileSync(join(mirror, name), "utf8")), recorded, `mirror/${name} drifted — re-run javascript-games' tools/mirror-riding-sim.mjs`);
  }
  const expected = new Set([...Object.keys(manifest.emitted), "riding-sim-manifest.json"]);
  for (const entry of readdirSync(mirror)) assert.ok(expected.has(entry), `mirror/${entry} is not in the riding set`);
});

test("signatures are the API's: HMAC-SHA256 over the kind and the key-sorted payload", () => {
  const payload = { raceId: "race-12345678", playerId: "p1" };
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.equal(signRacePayload("s3cret", "seat", payload), createHmac("sha256", "s3cret").update('seat:{"playerId":"p1","raceId":"race-12345678"}').digest("hex"));
  assert.equal(verifyRacePayload("s3cret", "seat", payload, signRacePayload("s3cret", "seat", payload)), true);
  assert.equal(verifyRacePayload("other", "seat", payload, signRacePayload("s3cret", "seat", payload)), false);
  assert.equal(verifyRacePayload("s3cret", "ticket", payload, signRacePayload("s3cret", "seat", payload)), false, "a seat is not a ticket");
});

const SECRET = "test-secret";
const fed = { hunger: 90, happiness: 90, elder: false };

function setup({ courseId = "gallop", startsAt = 10_000 } = {}) {
  let clock = 0;
  const sent = [];
  const bridge = createDownsRaceBridge({
    sendToClient: (clientId, payload) => sent.push({ clientId, payload }),
    now: () => clock,
    secret: () => SECRET,
    setRepeating: () => 1,
    clearRepeating: () => undefined,
  });
  const entries = [
    { playerId: "fast", name: "Ann", horseName: "Comet", paletteId: "standard", size: 1, profile: rideProfile({ speed: 95, strength: 70, stamina: 90, agility: 60 }, fed) },
    { playerId: "slow", name: "Bo", horseName: "Plod", paletteId: "grey", size: 1, profile: rideProfile({ speed: 20, strength: 40, stamina: 40, agility: 40 }, fed) },
  ];
  const payload = { raceId: "race-abcdef12", courseId, startsAt, deadlineAt: startsAt + 8 * 60_000, entries };
  const ticket = { payload, signature: signRacePayload(SECRET, "ticket", payload) };
  const seat = (playerId) => signRacePayload(SECRET, "seat", { raceId: payload.raceId, playerId });
  return { bridge, sent, ticket, seat, setClock: (value) => { clock = value; }, clock: () => clock };
}

test("the room refuses a forged ticket, a forged seat and a seat for someone not riding", () => {
  const { bridge, sent, ticket, seat } = setup();
  bridge.handleClientMessage("c1", { type: "downs_race_join", raceId: ticket.payload.raceId, ticket: { ...ticket, payload: { ...ticket.payload, startsAt: 0 } }, playerId: "fast", seat: seat("fast") });
  assert.equal(sent.at(-1).payload.code, "BAD_TICKET");
  bridge.handleClientMessage("c1", { type: "downs_race_join", raceId: ticket.payload.raceId, ticket, playerId: "fast", seat: seat("slow") });
  assert.equal(sent.at(-1).payload.code, "BAD_SEAT");
  bridge.handleClientMessage("c1", { type: "downs_race_join", raceId: ticket.payload.raceId, ticket, playerId: "ghost", seat: seat("ghost") });
  assert.equal(sent.at(-1).payload.code, "BAD_SEAT");
  bridge.handleClientMessage("c1", { type: "downs_race_join", raceId: ticket.payload.raceId, ticket });
  assert.equal(sent.at(-1).payload.event, "downs_race_joined");
  assert.equal(sent.at(-1).payload.role, "watcher");
  bridge.handleClientMessage("c1", { type: "downs_race_input", raceId: ticket.payload.raceId, inputs: [{ seq: 1, input: 3 }] });
  assert.equal(sent.at(-1).payload.code, "NOT_RIDING", "a watcher has no reins");
});

test("two riders gallop the strip on the room's sim; the faster horse wins and the result is signed", () => {
  const { bridge, sent, ticket, seat, setClock, clock } = setup();
  bridge.handleClientMessage("a", { type: "downs_race_join", raceId: ticket.payload.raceId, ticket, playerId: "fast", seat: seat("fast") });
  bridge.handleClientMessage("b", { type: "downs_race_join", raceId: ticket.payload.raceId, ticket, playerId: "slow", seat: seat("slow") });
  const gallop = packRideInput({ urge: true, gallop: true, brake: false, left: false, right: false, jump: false });
  let seq = 0;
  setClock(ticket.payload.startsAt);
  let result = null;
  for (let step = 0; step < 60 * 60 * 3 && !result; step += 3) {
    seq += 3;
    for (const client of ["a", "b"]) bridge.handleClientMessage(client, { type: "downs_race_input", raceId: ticket.payload.raceId, inputs: [{ seq: seq - 2, input: gallop }, { seq: seq - 1, input: gallop }, { seq, input: gallop }] });
    setClock(clock() + 50);
    bridge.advanceAll();
    result = sent.find((entry) => entry.payload.event === "downs_race_result")?.payload ?? null;
  }
  assert.ok(result, "the race finished");
  assert.deepEqual(result.result.order, ["fast", "slow"]);
  assert.ok(result.result.finishTicks.fast < result.result.finishTicks.slow);
  assert.equal(verifyRacePayload(SECRET, "result", result.result, result.signature), true);
  const snapshot = sent.filter((entry) => entry.clientId === "a" && entry.payload.event === "downs_race_state").at(-1).payload;
  assert.ok(snapshot.acked > 0, "a rider's snapshot acknowledges its reins");
  // A late joiner still gets the result.
  bridge.handleClientMessage("c", { type: "downs_race_join", raceId: ticket.payload.raceId, ticket });
  assert.equal(sent.at(-1).payload.event, "downs_race_result");
});
