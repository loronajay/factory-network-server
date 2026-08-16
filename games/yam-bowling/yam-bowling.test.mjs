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
import { yamBowlingLobbyGame } from "./server/yam-bowling-lobby-game.mjs";
import { trajectoryDerivative, trajectoryX } from "./shared/yam-bowling-physics.mjs";

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
      ["socket-a", { playerId: "factory-a", displayName: "Alex", characterSlug: "daisy-monroe", skinId: "maid" }],
      ["socket-b", { playerId: "factory-b", displayName: "Blair", characterSlug: "nia-brooks" }],
    ]),
  };
}

function gutterShot() {
  return { position: 0.46, aim: 0.45, hook: 1, power: 0.08, release: 0.035, ballIndex: 0, expectedRollNumber: 0 };
}

test("keeps the authoritative hook target and entry angle in sync with the cabinet", () => {
  const shot = { position: 0.3, aim: -0.12, hook: -1, hookScale: 1, power: 0.78 };

  assert.ok(Math.abs(trajectoryX(0.86, shot) - (-0.004853659947148564)) < 1e-12);
  assert.ok(trajectoryDerivative(0.86, shot) < -1.6);
});

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

test("equipped skins ride with each bowler into the authoritative match and any rematch", () => {
  const match = createYamMatchState(createLobby(), 5000);
  // The opponent only sees the skin the shooter equipped if the server carries it.
  assert.deepEqual(match.players.map((player) => player.skinId), ["maid", "canon"]);

  const snapshot = serializeYamMatch(match, { status: "started" }, 5000);
  assert.deepEqual(snapshot.match.players.map((player) => player.skinId), ["maid", "canon"]);

  match.phase = "complete";
  const rematch = requestYamRematch(requestYamRematch(match, "socket-a", 7000).match, "socket-b", 7100);
  assert.equal(rematch.started, true);
  assert.deepEqual(rematch.match.players.map((player) => player.skinId), ["maid", "canon"]);
});

test("a yam profile publishes the bowler and skin to the lobby roster but never the identity", () => {
  const lobby = createLobby();
  lobby.status = "open";
  yamBowlingLobbyGame.handleMessage(
    lobby,
    "socket-a",
    "yam_profile",
    JSON.stringify({ characterSlug: "Roxy-Chen", skinId: "swimsuit", playerId: "spoofed", displayName: "Impostor", protocolVersion: 1 }),
  );

  const profile = lobby.yamProfiles.get("socket-a");
  assert.equal(profile.characterSlug, "roxy-chen");
  assert.equal(profile.skinId, "swimsuit");
  assert.equal(profile.playerId, "factory-a");
  assert.equal(profile.displayName, "Alex");

  assert.deepEqual(lobby.publicPlayerFields.get("socket-a"), { characterSlug: "roxy-chen", skinId: "swimsuit" });
});

test("an unusable skin id falls back to the classic look instead of a broken sprite path", () => {
  const lobby = createLobby();
  yamBowlingLobbyGame.handleMessage(
    lobby,
    "socket-b",
    "yam_profile",
    JSON.stringify({ characterSlug: "nia-brooks", skinId: "../../etc/passwd", protocolVersion: 1 }),
  );
  assert.equal(lobby.yamProfiles.get("socket-b").skinId, "canon");
});

test("the server rolls one shared lane per match without owning the lane catalog", () => {
  const match = createYamMatchState(createLobby(), 5000);
  assert.equal(Number.isInteger(match.laneRoll), true);
  assert.equal(match.laneRoll >= 0, true);

  // The roll is an opaque number, never a lane name: the client owns the catalog
  // that turns it into artwork, exactly as it owns the skin catalog.
  const serialized = JSON.stringify(serializeYamMatch(match, { status: "started" }, 6000));
  assert.match(serialized, /"laneRoll":\d+/);
  assert.doesNotMatch(serialized, /lane[A-Za-z]*Slug|crimson-crown/);
});

test("both bowlers are served the same lane for the life of a match", () => {
  const lobby = createLobby();
  const match = createYamMatchState(lobby, 5000);
  const first = serializeYamMatch(match, lobby, 6000).laneRoll;

  const afterShot = applyYamShot(match, "socket-a", gutterShot(), 6000).match;
  assert.equal(serializeYamMatch(afterShot, lobby, 7000).laneRoll, first);

  const paused = applyYamDisconnect(afterShot, "socket-b", 8000);
  assert.equal(serializeYamMatch(paused, lobby, 8000).laneRoll, first);
  const resumed = applyYamReconnect(paused, "socket-b", 9000);
  assert.equal(serializeYamMatch(resumed, lobby, 9000).laneRoll, first);
});

test("a lane is reproducible from the match identity and differs between rooms", () => {
  const repeated = createYamMatchState(createLobby(), 5000).laneRoll;
  assert.equal(createYamMatchState(createLobby(), 9999).laneRoll, repeated);

  const otherRoom = createLobby();
  otherRoom.roomCode = "YAM99";
  otherRoom.seed = 987654;
  assert.notEqual(createYamMatchState(otherRoom, 5000).laneRoll, repeated);
});

test("rematches move the pair to a different lane", () => {
  const lobby = createLobby();
  let match = createYamMatchState(lobby, 5000);
  match = { ...match, phase: "complete", status: "complete" };
  requestYamRematch(match, "socket-a", 9000);
  const rematch = requestYamRematch(
    requestYamRematch(match, "socket-a", 9000).match,
    "socket-b",
    9100,
  );
  assert.equal(rematch.started, true);
  assert.equal(rematch.match.matchNumber, 2);
  assert.notEqual(rematch.match.laneRoll, match.laneRoll);
});

test("lane rolls spread across a catalog rather than sticking to one house", () => {
  const rolls = new Set();
  for (let seed = 0; seed < 40; seed += 1) {
    const lobby = createLobby();
    lobby.seed = seed;
    rolls.add(createYamMatchState(lobby, 5000).laneRoll % 9);
  }
  assert.equal(rolls.size, 9, "every lane in a nine-lane catalog should be reachable");
});
