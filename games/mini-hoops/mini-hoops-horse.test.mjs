import assert from "node:assert/strict";
import test from "node:test";

import { adjudicateHorseShot } from "./server/horse-adjudicator.mjs";
import { horseLobbyGame } from "./server/horse-lobby-game.mjs";
import {
  applyHorseDisconnect,
  applyHorsePlacement,
  applyHorseReconnect,
  applyHorseShot,
  createHorseMatchState,
  sanitizeHorsePlacement,
  serializeHorseMatch,
  sanitizeHorseShot,
} from "./server/horse-match-engine.mjs";
import { PLACEMENT_BOUNDS } from "./shared/scripts/sim/bin-placement.js";
import { HOOP_PLACEMENT_BOUNDS } from "./shared/scripts/sim/hoop-placement.js";
import { REFERENCE_POWER } from "./shared/scripts/sim/constants.js";
import { horsePowerForDepth, horseTargetAt } from "./shared/scripts/sim/horse-shot.js";
import { projectPoint } from "./shared/scripts/sim/projection.js";

function lobby(settings = { word: "PIG" }) {
  return {
    roomCode: "HORSE",
    gameId: "mini-hoops-horse",
    members: new Set(["socket-a", "socket-b"]),
    memberProfiles: new Map([
      ["socket-a", { playerId: "factory-a", displayName: "Ana" }],
      ["socket-b", { playerId: "factory-b", displayName: "Bo" }],
    ]),
    settings,
  };
}

const STILL_BIN = { x: 0, y: 0.36, z: 0.6, motionId: "still" };
// A hung hoop, in the wire shape a client actually submits one in.
const STILL_HOOP = { kind: "hoop", motionId: "still", placement: { cx: 440, rimY: 210 } };

/**
 * The pull that drops a ball into a given target — the CPU's own aim.
 *
 * TWO GESTURES, because the two targets take two. At a bin, strength picks how
 * far down the room the ball lands, so the perfect pull is the one whose depth
 * is the bin's. At a hoop there is no depth to pick — it hangs at the one there
 * is — so strength is power and the perfect pull is the calibrated reference,
 * aimed at the rim's own lane. Getting this wrong in the test would look exactly
 * like the adjudicator being broken.
 */
function perfectShot(setup, expectedShots = 0) {
  const resolved = horseTargetAt(setup, 0);
  const hoop = resolved.hoop;
  return {
    power: hoop ? REFERENCE_POWER : horsePowerForDepth(resolved.bin.z),
    aimX: hoop ? hoop.cx : projectPoint(resolved.bin).x,
    loft: 1,
    motionSeconds: 0,
    expectedShots,
  };
}

const MISS = { power: 0.02, aimX: 330, loft: 0, motionSeconds: 0, expectedShots: 0 };

test("a match is built from the host's word and the lobby's identities", () => {
  const state = createHorseMatchState(lobby({ word: "p i g !" }), 2_000);
  assert.equal(state.authorityMode, "server");
  assert.equal(state.config.word, "PIG");
  assert.equal(state.match.word, "PIG");
  assert.deepEqual(state.match.players.map((player) => player.accountPlayerId), ["factory-a", "factory-b"]);
  assert.equal(state.match.turn, 0);
  assert.equal(state.pendingSetup, null);
});

test("a placement is re-clamped into the legal volume, however it arrives", () => {
  const state = createHorseMatchState(lobby(), 2_000);
  const next = applyHorsePlacement(state, "socket-a", { x: 99, y: 99, z: 99, motionId: "nonsense" });
  assert.notEqual(next, state);
  assert.equal(next.pendingSetup.motionId, "still");
  assert.ok(next.pendingSetup.placement.z <= PLACEMENT_BOUNDS.maxZ + 1e-9);
  assert.deepEqual(next.pendingSetup, sanitizeHorsePlacement({ x: 99, y: 99, z: 99, motionId: "nonsense" }));
});

test("a setup with no kind is a bin, not the target catalog's own default", () => {
  // `trickShotTargetKind` opens on the hoop because the Trick Shot Lab does. A
  // HORSE placement submitted by a client from before the hoop existed carries
  // no kind and was a bin every time, so defaulting the other way here would
  // change the target of a match already in flight.
  assert.equal(sanitizeHorsePlacement(STILL_BIN).kind, "bin");
  assert.equal(sanitizeHorsePlacement({}).kind, "bin");
  assert.equal(sanitizeHorsePlacement(STILL_HOOP).kind, "hoop");
});

test("a hung hoop is clamped onto the wall, and its motion catalog is the hoop's", () => {
  const wild = sanitizeHorsePlacement({
    kind: "hoop",
    motionId: "sideways",
    placement: { cx: 9_000, rimY: -9_000 },
  });
  // `sideways` is a BIN motion. The ids do not cross, so it falls back to the
  // hoop catalog's own default rather than being mapped across.
  assert.equal(wild.motionId, "still");
  assert.ok(wild.placement.cx <= HOOP_PLACEMENT_BOUNDS.maxX + 1e-9);
  assert.ok(wild.placement.cx >= HOOP_PLACEMENT_BOUNDS.minX - 1e-9);
  assert.ok(wild.placement.rimY >= HOOP_PLACEMENT_BOUNDS.minY - 1e-9);
  assert.ok(wild.placement.rimY <= HOOP_PLACEMENT_BOUNDS.maxY + 1e-9);
});

test("a placement strips disabled HORSE trick-shot tools", () => {
  const setup = sanitizeHorsePlacement({
    ...STILL_BIN,
    locationId: "warehouse",
    pieces: [{ type: "board", id: "bank-pad", x: 0.4, y: 0.8, z: 0.5, restitution: 0.9 }],
  });
  assert.equal(setup.locationId, "warehouse");
  assert.equal(setup.pieces.length, 0);
});

test("only the player whose turn it is may place, and never a matcher", () => {
  let state = createHorseMatchState(lobby(), 2_000);
  assert.equal(applyHorsePlacement(state, "socket-b", STILL_BIN), state, "not your turn");

  state = applyHorsePlacement(state, "socket-a", STILL_BIN);
  state = applyHorseShot(state, "socket-a", perfectShot(STILL_BIN), 3_000);
  assert.equal(state.match.phase, "match", "a made setup becomes a standing shot");
  assert.equal(state.match.turn, 1);
  // The matcher owes THAT bin. A placement from them changes nothing.
  assert.equal(applyHorsePlacement(state, "socket-b", { ...STILL_BIN, z: 0.4 }), state);
});

test("the server rules on the pull, and a claimed outcome is not even read", () => {
  let state = createHorseMatchState(lobby(), 2_000);
  state = applyHorsePlacement(state, "socket-a", STILL_BIN);
  state = applyHorseShot(state, "socket-a", { ...MISS, made: true, letters: 9 }, 3_000);
  assert.equal(state.lastShot.made, false, "a miss is a miss whatever the browser says");
  assert.equal("made" in state.lastShot.intent, false);
  assert.equal(state.match.players[0].letters, 0, "a setter who misses loses nothing");
  assert.equal(state.match.turn, 1, "and control passes");
});

test("a shot's catalog ball is sanitized and carried into the ruling", () => {
  assert.equal(sanitizeHorseShot({ ballId: "snowball" }).ballId, "snowball");
  assert.equal(sanitizeHorseShot({ ballId: "../../bad" }).ballId, "basketball");

  let state = createHorseMatchState(lobby(), 2_000);
  state = applyHorsePlacement(state, "socket-a", STILL_BIN);
  let adjudicatedBall = "";
  state = applyHorseShot(
    state,
    "socket-a",
    { ...MISS, ballId: "paper" },
    3_000,
    ({ intent }) => { adjudicatedBall = intent.ballId; return { made: false }; },
  );
  assert.equal(adjudicatedBall, "paper");
  assert.equal(state.lastShot.intent.ballId, "paper");
});

test("a matcher is adjudicated with the setter's ball, never their submitted replacement", () => {
  let state = createHorseMatchState(lobby(), 2_000);
  state = applyHorsePlacement(state, "socket-a", STILL_BIN);
  state = applyHorseShot(
    state,
    "socket-a",
    { ...perfectShot(STILL_BIN), ballId: "bowling-ball" },
    3_000,
    () => ({ made: true }),
  );
  assert.equal(state.match.standingShot.ballId, "bowling-ball");

  let adjudicatedBall = "";
  state = applyHorseShot(
    state,
    "socket-b",
    { ...MISS, expectedShots: 1, ballId: "paper" },
    3_100,
    ({ intent }) => { adjudicatedBall = intent.ballId; return { made: false }; },
  );
  assert.equal(adjudicatedBall, "bowling-ball");
  assert.equal(state.lastShot.intent.ballId, "bowling-ball");
});

test("a shot with nothing placed is ignored rather than adjudicated", () => {
  const state = createHorseMatchState(lobby(), 2_000);
  assert.equal(applyHorseShot(state, "socket-a", perfectShot(STILL_BIN), 3_000), state);
});

test("a resent shot names a spent shot number and is dropped", () => {
  let state = createHorseMatchState(lobby(), 2_000);
  state = applyHorsePlacement(state, "socket-a", STILL_BIN);
  const shot = perfectShot(STILL_BIN);
  state = applyHorseShot(state, "socket-a", shot, 3_000);
  assert.equal(state.match.shots, 1);
  assert.equal(applyHorseShot(state, "socket-b", shot, 3_050), state, "the duplicate cannot fire twice");
});

test("the setter keeps control until they miss a shot of their own", () => {
  let state = createHorseMatchState(lobby(), 2_000);
  state = applyHorsePlacement(state, "socket-a", STILL_BIN);
  state = applyHorseShot(state, "socket-a", perfectShot(STILL_BIN, 0), 3_000);
  // Matched: no letter, and the setter sets again rather than handing over.
  state = applyHorseShot(state, "socket-b", perfectShot(STILL_BIN, 1), 3_100);
  assert.equal(state.match.players[1].letters, 0);
  assert.equal(state.match.turn, 0);
  assert.equal(state.match.phase, "set");
  assert.equal(state.pendingSetup, null, "and has to place a new bin");
});

test("spelling the word completes the match and ends the lobby", () => {
  const room = lobby();
  room.horseMatch = createHorseMatchState(room, Date.now());
  const play = (client, payload) => horseLobbyGame.handleMessage(room, client, "horse_shot", JSON.stringify(payload));

  for (let letter = 0; letter < 3; letter += 1) {
    horseLobbyGame.handleMessage(room, "socket-a", "horse_placement", JSON.stringify(STILL_BIN));
    play("socket-a", perfectShot(STILL_BIN, room.horseMatch.match.shots));
    play("socket-b", { ...MISS, expectedShots: room.horseMatch.match.shots });
  }
  assert.equal(room.horseMatch.match.players[1].letters, 3);
  assert.equal(room.horseMatch.match.status, "won");
  assert.equal(room.horseMatch.match.winner, 0);
  assert.equal(room.horseMatch.phase, "complete");
  assert.equal(room.status, "ended");
});

test("the lobby adapter refuses a client-authored result", () => {
  const room = lobby();
  room.horseMatch = createHorseMatchState(room, Date.now());
  const forged = horseLobbyGame.handleMessage(room, "socket-a", "horse_result", JSON.stringify({ made: true }));
  assert.equal(forged.error.code, "SERVER_AUTHORITY");
  assert.equal(horseLobbyGame.handleMessage(room, "socket-a", "chat", "{}").handled, false);
});

test("a disconnect pauses the match, and a second one forfeits it", () => {
  const state = createHorseMatchState(lobby(), 2_000);
  const paused = applyHorseDisconnect(state, "socket-b");
  assert.equal(paused.phase, "paused");
  assert.equal(applyHorsePlacement(paused, "socket-a", STILL_BIN), paused, "nobody shoots at a paused court");
  assert.equal(applyHorseReconnect(paused, "socket-b").phase, "live");

  const forfeited = applyHorseDisconnect(paused, "socket-b");
  assert.equal(forfeited.phase, "complete");
  assert.equal(forfeited.match.winner, 0);
  assert.equal(serializeHorseMatch(forfeited).result.reason, "forfeit");
});

test("the serialized snapshot carries the bin both clients have to draw", () => {
  let state = createHorseMatchState(lobby(), 2_000);
  state = applyHorsePlacement(state, "socket-a", { ...STILL_BIN, motionId: "sideways" });
  const snapshot = serializeHorseMatch(state, 9_000);
  assert.equal(snapshot.serverNow, 9_000);
  assert.equal(snapshot.pendingSetup.motionId, "sideways");
  assert.equal(snapshot.match.word, "PIG");
  assert.equal(snapshot.result, null);
});

test("the production adjudicator rules on a hung hoop as well as a placed bin", () => {
  // The whole point of the dispatch: the same call, the same wire shape, and a
  // different integrator underneath. A hoop shot is ruled through `stepBall`.
  const setup = sanitizeHorsePlacement(STILL_HOOP);
  assert.equal(adjudicateHorseShot({ intent: perfectShot(setup), setup, motionSeconds: 0 }).made, true);
  // And it is genuinely the hoop being hit, not something that scores anyway.
  const wide = { ...perfectShot(setup), aimX: HOOP_PLACEMENT_BOUNDS.minX };
  assert.equal(adjudicateHorseShot({ intent: wide, setup, motionSeconds: 0 }).made, false);
});

test("the production adjudicator agrees with the cabinet's own perfect shot", () => {
  assert.equal(adjudicateHorseShot({ intent: perfectShot(STILL_BIN), setup: STILL_BIN, motionSeconds: 0 }).made, true);
  // A moving bin is not tracked, and the ruling proves it. The identical pull,
  // aimed where the bin was PLACED, misses when the bin is sitting there at
  // release — it has walked off by the time the ball arrives — and drops when it
  // is fired 0.9s into the sweep, with the bin on its way back to meet it.
  // Leading it is the skill; the server rules on the phase the player chose.
  const sideways = { ...STILL_BIN, motionId: "sideways" };
  assert.equal(adjudicateHorseShot({ intent: perfectShot(sideways), setup: sideways, motionSeconds: 0 }).made, false);
  assert.equal(adjudicateHorseShot({ intent: perfectShot(sideways), setup: sideways, motionSeconds: 0.9 }).made, true);
});
