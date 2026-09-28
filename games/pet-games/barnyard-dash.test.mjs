// Barnyard Dash, server-authoritative.
//
// A client may send its pet (before the race) and its keys (during it). Every
// position, hurdle, checkpoint, finish and placing is the tick's answer.
import assert from "node:assert/strict";
import test from "node:test";

import { lobbyGame, matchmakingStrategy } from "../registry.mjs";
import { doesLobbyMatchSearch } from "../../src/lobby.mjs";
import { sanitizeLobbySettings } from "../../src/util.mjs";
import { lobbies } from "../../src/state.mjs";
import { barnyardDashLobbyGame } from "./server/barnyard-dash-lobby-game.mjs";
import {
  BARNYARD_GAME_ID,
  BARNYARD_LOBBY_LIMITS,
  advanceBarnyardMatch,
  applyBarnyardDisconnect,
  applyBarnyardInput,
  applyBarnyardReconnect,
  courseForLobby,
  createBarnyardMatch,
  serializeBarnyardMatch,
} from "./server/barnyard-dash-match-engine.mjs";
import { COURSE_IDS } from "./mirror/games/barnyard-dash/scripts/sim/courses.js";

const START_AT = 1_000_000;
const TICK_MS = 1000 / 60;

function makeLobby(memberIds = ["c_a", "c_b"], settings = {}) {
  const lobby = {
    roomCode: "BARNY",
    gameId: BARNYARD_GAME_ID,
    seed: "seed-1",
    status: "open",
    members: new Set(memberIds),
    memberProfiles: new Map(memberIds.map((id, index) => [id, { displayName: `Player ${index + 1}`, playerId: `acct-${index + 1}` }])),
    settings: sanitizeLobbySettings(settings),
  };
  lobbies.set(lobby.roomCode, lobby);
  return lobby;
}

const at = (ticks) => START_AT + Math.ceil(ticks * TICK_MS);

test("the game is a lobby game with its own seat limits, two to eight", () => {
  assert.equal(lobbyGame(BARNYARD_GAME_ID), barnyardDashLobbyGame);
  assert.deepEqual(matchmakingStrategy(BARNYARD_GAME_ID), { strategy: "lobby" });
  assert.deepEqual(barnyardDashLobbyGame.lobbyLimits, BARNYARD_LOBBY_LIMITS);
  assert.deepEqual(BARNYARD_LOBBY_LIMITS, { minPlayers: 2, maxPlayers: 8 });
});

test("the CPU count and level are the host's: a searcher who asked for neither still joins", () => {
  const lobby = { gameId: BARNYARD_GAME_ID, status: "open", isPrivate: false, minPlayers: 2, maxPlayers: 8, members: new Set(["c_host"]), settings: sanitizeLobbySettings({ cpuCount: 4, cpuLevel: 2 }) };
  assert.equal(lobby.settings.cpuLevel, 2);
  assert.equal(sanitizeLobbySettings({ cpuLevel: 99 }).cpuLevel, 2);
  assert.equal(sanitizeLobbySettings({}).cpuLevel, 1);
  assert.equal(doesLobbyMatchSearch(lobby, BARNYARD_GAME_ID, { minPlayers: 2, maxPlayers: 8 }, {}), true);
});

test("a pet named in the lobby is sanitized, shown on the roster and raced", () => {
  const lobby = makeLobby();
  barnyardDashLobbyGame.handleMessage(lobby, "c_a", "pet_profile", JSON.stringify({ pet: { speciesId: "pet.shark", name: "Finn", paletteId: "voidfin", stats: { speed: 400, strength: 70, size: 1 } } }));
  assert.equal(lobby.publicPlayerFields.get("c_a").pet.name, "Finn");
  assert.equal(lobby.petProfiles.get("c_a").stats.speed, 100, "stats are held to the farm's range");
  const match = createBarnyardMatch(lobby, START_AT);
  assert.equal(match.race.racers[0].pet.speciesId, "pet.shark");
  assert.equal(match.race.racers[0].profile.speedMultiplier, 1.1, "the pet's own (clamped) Speed reaches the race");
  assert.equal(match.race.racers[0].profile.strength, 70);
  assert.equal(match.race.racers[1].pet.name, "Borrowed Biscuit", "a person who named no pet races the loaner");
});

test("CPU guests fill only the chairs people left empty, at the host's level, from the rival pool", () => {
  const match = createBarnyardMatch(makeLobby(["c_a", "c_b", "c_c"], { cpuCount: 6, cpuLevel: 0 }), START_AT);
  assert.equal(match.race.racers.length, 8, "three people and five CPUs fill eight chairs");
  const cpus = match.race.racers.filter((racer) => racer.cpu);
  assert.equal(cpus.length, 5);
  assert.ok(cpus.every((racer) => racer.cpu === "rookie" && racer.id.startsWith("rival.")));
  assert.equal(createBarnyardMatch(makeLobby(["c_a", "c_b"]), START_AT).race.racers.length, 2, "no CPUs unless asked");
});

test("the host's course is raced; a quick room draws one from its seed", () => {
  assert.equal(courseForLobby(makeLobby(["c_a"], { mapId: "thunder-ridge" })).id, "thunder-ridge");
  assert.ok(COURSE_IDS.includes(courseForLobby(makeLobby(["c_a"], {})).id));
  const match = createBarnyardMatch(makeLobby(["c_a", "c_b"], { mapId: "millpond-oval" }), START_AT);
  assert.equal(match.race.totalLaps, 4);
});

test("nothing moves before the start, and a seat nobody drives stands on the grid", () => {
  const match = createBarnyardMatch(makeLobby(), START_AT);
  assert.equal(advanceBarnyardMatch(match, START_AT - 1), false);
  assert.equal(match.phase, "scheduled");
  for (let tick = 3; tick <= 60 * 5; tick += 3) advanceBarnyardMatch(match, at(tick));
  assert.equal(match.race.status, "racing");
  assert.equal(match.race.racers[1].speed, 0);
});

test("a person's queued inputs drive only their own seat and are acknowledged by sequence", () => {
  const match = createBarnyardMatch(makeLobby(), START_AT);
  let seq = 0;
  const inputs = () => Array.from({ length: 6 }, () => ({ seq: (seq += 1), input: { throttle: true } }));
  let now = START_AT;
  for (let batch = 0; batch < 60; batch += 1) {
    applyBarnyardInput(match, "c_a", { inputs: inputs() });
    now += 6 * TICK_MS;
    advanceBarnyardMatch(match, now);
  }
  const [mine, theirs] = match.race.racers;
  assert.ok(mine.speed > 100, "the keys reached seat one");
  assert.equal(theirs.speed, 0, "and nobody else's");
  const snapshot = serializeBarnyardMatch(match);
  assert.equal(snapshot.acks.c_a, seq, "every input taken is acknowledged");
  assert.equal(snapshot.acks.c_b, 0);
  assert.equal(applyBarnyardInput(match, "c_stranger", { inputs: inputs() }), false);
});

test("a stale or replayed input is ignored", () => {
  const match = createBarnyardMatch(makeLobby(), START_AT);
  applyBarnyardInput(match, "c_a", { inputs: [{ seq: 5, input: { throttle: true } }] });
  applyBarnyardInput(match, "c_a", { inputs: [{ seq: 5, input: { throttle: true } }, { seq: 3, input: { throttle: true } }] });
  assert.equal(match.queues.get("c_a").queue.length, 1);
});

test("the server refuses every client-authored outcome", () => {
  const lobby = makeLobby();
  for (const type of ["barnyard_state", "barnyard_snapshot", "barnyard_match_ended", "barnyard_finish", "barnyard_result", "state_sync"]) {
    const result = barnyardDashLobbyGame.handleMessage(lobby, "c_a", type, JSON.stringify({ place: 1 }));
    assert.equal(result.error?.code, "SERVER_AUTHORITY", type);
  }
});

test("a dropped seat coasts through its grace window; a seat gone for good is out of the race", () => {
  const match = createBarnyardMatch(makeLobby(["c_a", "c_b", "c_c"]), START_AT);
  for (let tick = 3; tick <= 60 * 4; tick += 3) advanceBarnyardMatch(match, at(tick));
  applyBarnyardDisconnect(match, "c_b", true);
  assert.equal(match.race.racers[1].dnf, false);
  assert.equal(applyBarnyardReconnect(match, "c_b"), true);
  applyBarnyardDisconnect(match, "c_c", false);
  assert.equal(match.race.racers[2].dnf, true);
});

test("a whole online race runs to its end on the server alone, with results naming each seat", () => {
  const lobby = makeLobby(["c_a", "c_b"], { mapId: "barnyard-loop", cpuCount: 2, cpuLevel: 2 });
  const match = createBarnyardMatch(lobby, START_AT);
  // Both people walk away; the CPUs finish, the window closes, the race ends.
  applyBarnyardDisconnect(match, "c_a", false);
  let now = START_AT;
  let ended = false;
  for (let step = 0; step < 60 * 60 * 5 && !ended; step += 3) {
    now += 3 * TICK_MS;
    ended = advanceBarnyardMatch(match, now);
  }
  assert.equal(ended, true);
  const snapshot = serializeBarnyardMatch(match);
  assert.equal(snapshot.phase, "complete");
  assert.equal(snapshot.results.length, 4);
  assert.ok(snapshot.results.slice(0, 2).every((row) => !row.human && Number.isFinite(row.finishedAt)));
  assert.equal(snapshot.results.find((row) => row.seatId === "seat-1").accountPlayerId, "acct-1");
});
