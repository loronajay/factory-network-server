import test from "node:test";
import assert from "node:assert/strict";

import {
  YAM_BOWLING_GAME_ID,
  applyYamDisconnect,
  applyYamReconnect,
  applyYamShot,
  createYamMatchState,
  requestYamRematch,
  serializeYamMatch,
} from "./server/yam-bowling-match-engine.mjs";

function createLobby(modeId = "quick") {
  return {
    roomCode: "YAM42",
    seed: 1234,
    settings: { matchType: modeId, protocolVersion: 1 },
    members: new Set(["socket-a", "socket-b"]),
    memberProfiles: new Map([
      ["socket-a", { playerId: "factory-a", displayName: "Alex" }],
      ["socket-b", { playerId: "factory-b", displayName: "Blair" }],
    ]),
    yamProfiles: new Map([
      ["socket-a", { playerId: "factory-a", displayName: "Alex", characterSlug: "daisy-monroe" }],
      ["socket-b", { playerId: "factory-b", displayName: "Blair", characterSlug: "nia-brooks" }],
    ]),
  };
}

function gutterShot() {
  return { position: 0.46, aim: 0.45, hook: 1, power: 0.08, release: 0.035, ballIndex: 0, expectedRollNumber: 0 };
}

test("creates a two-player account-bound authoritative bowling match", () => {
  const match = createYamMatchState(createLobby(), 5000);
  assert.equal(match.gameId, YAM_BOWLING_GAME_ID);
  assert.equal(match.modeId, "quick");
  assert.equal(match.phase, "playing");
  assert.equal(match.players.length, 2);
  assert.deepEqual(match.players.map((player) => player.accountPlayerId), ["factory-a", "factory-b"]);
  assert.deepEqual(match.players.map((player) => player.characterSlug), ["daisy-monroe", "nia-brooks"]);
  assert.equal(match.activePlayer, 0);
  assert.equal(match.rollNumber, 0);
  assert.match(match.sessionId, /^yam-bowling:YAM42:/);
});

test("replays declared shot inputs and owns the roll result", () => {
  const original = createYamMatchState(createLobby(), 5000);
  const first = applyYamShot(original, "socket-a", gutterShot(), 6000);
  assert.equal(first.error, null);
  assert.notEqual(first.match, original);
  assert.equal(first.match.rollNumber, 1);
  assert.equal(first.match.lastRoll.shooterClientId, "socket-a");
  assert.deepEqual(first.match.lastRoll.shot, {
    position: 0.46, aim: 0.45, hook: 1, power: 0.08, release: 0.035, ballIndex: 0,
  });
  assert.equal(Number.isInteger(first.match.lastRoll.knocked), true);
  assert.equal(first.match.lastRoll.knocked >= 0 && first.match.lastRoll.knocked <= 10, true);
  assert.equal(first.match.players[0].frames[0][0], first.match.lastRoll.knocked);
  assert.equal(Array.isArray(first.match.lastRoll.pinsBefore), true);
  assert.equal(Array.isArray(first.match.lastRoll.pinsAfter), true);

  const replay = applyYamShot(createYamMatchState(createLobby(), 5000), "socket-a", gutterShot(), 6000);
  assert.equal(replay.match.lastRoll.knocked, first.match.lastRoll.knocked);
  assert.deepEqual(replay.match.lastRoll.pinsAfter, first.match.lastRoll.pinsAfter);
});

test("rejects out-of-turn, stale, and malformed shot requests", () => {
  const match = createYamMatchState(createLobby(), 5000);
  assert.equal(applyYamShot(match, "socket-b", gutterShot(), 6000).error.code, "NOT_YOUR_TURN");
  assert.equal(applyYamShot(match, "socket-a", { ...gutterShot(), ballIndex: 99 }, 6000).error.code, "INVALID_SHOT");

  const accepted = applyYamShot(match, "socket-a", gutterShot(), 6000).match;
  assert.equal(applyYamShot(accepted, "socket-a", gutterShot(), 6001).error.code, "NOT_READY_FOR_SHOT");
});

test("serializes the authoritative scorecard, next rack, and last roll", () => {
  const lobby = createLobby("classic");
  const match = applyYamShot(createYamMatchState(lobby, 5000), "socket-a", gutterShot(), 6000).match;
  const snapshot = serializeYamMatch(match, lobby, 6100);
  assert.equal(snapshot.authorityMode, "server");
  assert.equal(snapshot.modeId, "classic");
  assert.equal(snapshot.rollNumber, 1);
  assert.equal(snapshot.match.players[0].accountPlayerId, "factory-a");
  assert.equal(snapshot.activeClientId, snapshot.match.players[snapshot.match.activePlayer].id);
  assert.equal(snapshot.lastRoll.rollNumber, 1);
  assert.equal(Array.isArray(snapshot.nextPins), true);
});

test("disconnect pauses for grace, reconnect restores play, and expiry awards a forfeit", () => {
  const match = createYamMatchState(createLobby(), 5000);
  const paused = applyYamDisconnect(match, "socket-b", 6000);
  assert.equal(paused.phase, "paused");
  assert.equal(paused.players[1].connected, false);

  const resumed = applyYamReconnect(paused, "socket-b", 6500);
  assert.equal(resumed.phase, "playing");
  assert.equal(resumed.players[1].connected, true);

  const expired = applyYamDisconnect(paused, "socket-b", 36000);
  assert.equal(expired.phase, "complete");
  assert.equal(expired.result.reason, "disconnect");
  assert.equal(expired.result.winnerClientId, "socket-a");
});

test("rematch requires both players and resets the authoritative scorecard", () => {
  const match = createYamMatchState(createLobby(), 5000);
  match.phase = "complete";
  match.result = { reason: "score", winnerClientId: "socket-a" };

  const first = requestYamRematch(match, "socket-a", 7000);
  assert.equal(first.started, false);
  assert.deepEqual(first.match.rematchRequestedBy, ["socket-a"]);

  const second = requestYamRematch(first.match, "socket-b", 7100);
  assert.equal(second.started, true);
  assert.equal(second.match.phase, "playing");
  assert.equal(second.match.rollNumber, 0);
  assert.equal(second.match.players[0].score.total, 0);
  assert.notEqual(second.match.sessionId, match.sessionId);
});
