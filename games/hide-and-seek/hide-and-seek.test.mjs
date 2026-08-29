import assert from "node:assert/strict";
import test from "node:test";

import { hideAndSeekLobbyGame } from "./server/hide-and-seek-lobby-game.mjs";
import {
  HIDE_AND_SEEK_TICK_RATE,
  advanceHideAndSeekMatch,
  applyHideAndSeekDisconnect,
  applyHideAndSeekInput,
  applyHideAndSeekReconnect,
  chooseSeeker,
  createHideAndSeekMatchState,
  endRoundByDemon,
  serializeHideAndSeekMatch,
} from "./server/hide-and-seek-match-engine.mjs";

const MEMBERS = ["socket-a", "socket-b", "socket-c"];

function lobby(seed = "SEEDA") {
  return {
    roomCode: "HOTEL",
    gameId: "hide-and-seek",
    seed,
    members: new Set(MEMBERS),
    memberProfiles: new Map([
      ["socket-a", { playerId: "factory-a", displayName: "Ana" }],
      ["socket-b", { playerId: "factory-b", displayName: "Bo" }],
      ["socket-c", { playerId: "factory-c", displayName: "Cy" }],
    ]),
    settings: {},
  };
}

const walk = (yaw = Math.PI) => ({ forward: 1, strafe: 0, yaw, crouch: false, sprint: false, light: false });

function run(match, seconds, from = match.startAt) {
  const step = 1000 / HIDE_AND_SEEK_TICK_RATE;
  // Advance in single-tick calls so the per-advance cap never swallows simulated time.
  for (let elapsed = step; elapsed <= seconds * 1000; elapsed += step) advanceHideAndSeekMatch(match, from + elapsed);
  return match;
}

test("a match seats every member, names one seeker and starts them in the head start", () => {
  const match = createHideAndSeekMatchState(lobby(), 1_000);
  const view = serializeHideAndSeekMatch(match, 1_000);

  assert.equal(view.authorityMode, "server");
  assert.equal(view.players.length, 3);
  assert.equal(view.round.phase, "hiding");
  assert.equal(view.players.filter((player) => player.role === "seeker").length, 1);
  assert.equal(view.players.find((player) => player.id === match.seekerId).role, "seeker");
  assert.deepEqual(view.players.map((player) => player.name).sort(), ["Ana", "Bo", "Cy"]);
});

test("the seeker is chosen from the seed, so the same match always picks the same one", () => {
  assert.equal(chooseSeeker(MEMBERS, "SEEDA"), chooseSeeker(MEMBERS, "SEEDA"));
  const picks = new Set(["A", "B", "C", "D", "E", "F", "G", "H"].map((seed) => chooseSeeker(MEMBERS, seed)));
  assert.ok(picks.size > 1, "different seeds should be able to pick different seekers");
  assert.equal(chooseSeeker([], "SEEDA"), null);
});

test("nothing simulates before the scheduled start", () => {
  const match = createHideAndSeekMatchState(lobby(), 10_000);
  advanceHideAndSeekMatch(match, 9_000);

  assert.equal(match.phase, "scheduled");
  assert.equal(serializeHideAndSeekMatch(match).tick, 0);
});

test("an input moves a hider and never carries a position of its own", () => {
  const match = createHideAndSeekMatchState(lobby(), 0);
  const hiderId = MEMBERS.find((id) => id !== match.seekerId);
  const before = serializeHideAndSeekMatch(match).players.find((player) => player.id === hiderId);

  applyHideAndSeekInput(match, hiderId, { ...walk(), x: 999, z: 999, alive: true, flashlight: { charge: 1 } });
  run(match, 2);
  const after = serializeHideAndSeekMatch(match).players.find((player) => player.id === hiderId);

  assert.ok(Math.hypot(after.x - before.x, after.z - before.z) > 1, "the hider should have walked");
  assert.ok(Math.abs(after.x) < 900 && Math.abs(after.z) < 900, "a client-supplied position must be ignored");
});

test("the seeker cannot walk during the head start", () => {
  const match = createHideAndSeekMatchState(lobby(), 0);
  const before = serializeHideAndSeekMatch(match).players.find((player) => player.id === match.seekerId);

  applyHideAndSeekInput(match, match.seekerId, walk());
  run(match, 3);
  const after = serializeHideAndSeekMatch(match).players.find((player) => player.id === match.seekerId);

  assert.deepEqual({ x: after.x, z: after.z }, { x: before.x, z: before.z });
  assert.equal(serializeHideAndSeekMatch(match).round.phase, "hiding");
});

test("a client cannot report its own pose, catch or snapshot", () => {
  const held = { roomCode: "HOTEL", hideAndSeekMatch: createHideAndSeekMatchState(lobby(), 0) };

  for (const messageType of ["hide_and_seek_pose", "hide_and_seek_caught", "hide_and_seek_snapshot", "hide_and_seek_match_ended"]) {
    const result = hideAndSeekLobbyGame.handleMessage(held, "socket-a", messageType, "{}");
    assert.equal(result.handled, true);
    assert.equal(result.error.code, "SERVER_AUTHORITY");
  }
  assert.equal(hideAndSeekLobbyGame.handleMessage(held, "socket-a", "chat", "hi").handled, false);
});

test("a demon catch on the seeker ends the round for the hiders", () => {
  const match = createHideAndSeekMatchState(lobby(), 0);
  endRoundByDemon(match, match.seekerId);
  const view = serializeHideAndSeekMatch(match);

  assert.equal(match.phase, "complete");
  assert.equal(view.round.over, true);
  assert.equal(view.round.outcome, "hiders");
});

test("a dropped seeker settles the round; a dropped hider is left standing", () => {
  const dropped = createHideAndSeekMatchState(lobby(), 0);
  applyHideAndSeekDisconnect(dropped, dropped.seekerId, 1_000);
  assert.equal(dropped.phase, "complete");
  assert.equal(serializeHideAndSeekMatch(dropped).round.outcome, "hiders");

  const match = createHideAndSeekMatchState(lobby(), 0);
  const hiderId = MEMBERS.find((id) => id !== match.seekerId);
  applyHideAndSeekInput(match, hiderId, walk());
  assert.equal(applyHideAndSeekDisconnect(match, hiderId, 1_000), true);
  const at = serializeHideAndSeekMatch(match).players.find((player) => player.id === hiderId);
  run(match, 2);
  const later = serializeHideAndSeekMatch(match).players.find((player) => player.id === hiderId);

  assert.equal(match.phase, "active");
  assert.equal(later.connected, false);
  assert.equal(later.alive, true);
  assert.deepEqual({ x: later.x, z: later.z }, { x: at.x, z: at.z }, "a body nobody is driving stands still");
  assert.equal(applyHideAndSeekReconnect(match, hiderId), true);
  assert.equal(serializeHideAndSeekMatch(match).players.find((player) => player.id === hiderId).connected, true);
});

test("the lobby adapter runs a ticking match and always clears its interval", () => {
  const held = { roomCode: "HOTEL", status: "started" };
  hideAndSeekLobbyGame.initMatch(held, Date.now());
  assert.equal(hideAndSeekLobbyGame.hasActiveMatch(held), true);

  hideAndSeekLobbyGame.afterStart(held);
  assert.ok(held.hideAndSeekTimer, "the match should be ticking");
  hideAndSeekLobbyGame.clearTimers(held);
  assert.equal(held.hideAndSeekTimer, null);

  const started = hideAndSeekLobbyGame.startedPayloadExtras(held, Date.now());
  assert.equal(started.authorityMode, "server");
  assert.equal(started.matchState.players.length, 0);
});

test("the lobby seats between two and eight guests", () => {
  assert.deepEqual(hideAndSeekLobbyGame.lobbyLimits, { minPlayers: 2, maxPlayers: 8 });
  assert.equal(hideAndSeekLobbyGame.gameId, "hide-and-seek");
});
