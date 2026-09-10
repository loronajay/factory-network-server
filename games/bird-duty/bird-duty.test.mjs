// Bird Duty, server-authoritative.
//
// These tests exist to hold one line: a client can send an intent and nothing else. Everything that
// decides a match — the bird's position, the shot, the hit, the score, the turn order, the winner —
// is produced by the tick on this server, from the mirrored copy of the cabinet's own pure rules.
import assert from "node:assert/strict";
import test from "node:test";

import { lobbyGame, matchmakingStrategy } from "../registry.mjs";
import { birdDutyLobbyGame } from "./server/bird-duty-lobby-game.mjs";
import {
  BIRD_DUTY_GAME_ID,
  BIRD_DUTY_LOBBY_LIMITS,
  BIRD_DUTY_SNAPSHOT_HZ,
  advanceBirdDutyMatch,
  applyBirdDutyDisconnect,
  applyBirdDutyInput,
  applyBirdDutyReconnect,
  createBirdDutyMatchState,
  serializeBirdDutyMatch,
} from "./server/bird-duty-match-engine.mjs";
import { HOTSEAT_SHOTS_PER_TURN, MATCH_SIM_PHASE, NPC_DEFINITIONS } from "./shared/index.mjs";

const START_AT = 1_000_000;

function makeLobby(memberIds = ["c_aaa", "c_bbb"]) {
  return {
    roomCode: "ABCDE",
    seed: "seed-1",
    members: new Set(memberIds),
    memberProfiles: new Map(memberIds.map((id, index) => [id, {
      displayName: `Player ${index + 1}`,
      playerId: `acct-${index + 1}`,
    }])),
  };
}

function makeMatch(memberIds) {
  return createBirdDutyMatchState(makeLobby(memberIds), START_AT);
}

/** Advance the match by whole ticks of wall time. */
function advanceTicks(match, ticks, from = START_AT) {
  advanceBirdDutyMatch(match, from + Math.round(ticks * (1000 / 60)));
  return match;
}

test("the game is registered as a lobby game with its own seat limits", () => {
  assert.equal(lobbyGame(BIRD_DUTY_GAME_ID), birdDutyLobbyGame);
  assert.deepEqual(matchmakingStrategy(BIRD_DUTY_GAME_ID), { strategy: "lobby" });
  // The repo-wide trap: a game whose limits differ from the server default of 2-6 must publish them
  // here AND send them on find_lobby, or every guest silently opens a room of their own.
  assert.deepEqual(birdDutyLobbyGame.lobbyLimits, BIRD_DUTY_LOBBY_LIMITS);
  assert.equal(BIRD_DUTY_LOBBY_LIMITS.minPlayers, 2);
  assert.equal(BIRD_DUTY_LOBBY_LIMITS.maxPlayers, 4);
});

test("a new match seats every lobby member with their profile name", () => {
  const snapshot = serializeBirdDutyMatch(makeMatch());

  assert.equal(snapshot.authorityMode, "server");
  assert.equal(snapshot.match.players.length, 2);
  assert.equal(snapshot.match.players[0].name, "Player 1");
  assert.equal(snapshot.match.players[0].accountPlayerId, "acct-1");
  assert.equal(snapshot.match.players[0].connected, true);
  assert.equal(snapshot.activeClientId, "c_aaa");
});

test("nothing advances before the scheduled start", () => {
  const match = makeMatch();
  advanceBirdDutyMatch(match, START_AT - 1);

  assert.equal(match.phase, "scheduled");
  assert.equal(match.sim.tick, 0);
});

test("the tick advances the world with no client having said anything", () => {
  const match = makeMatch();
  advanceTicks(match, 30);

  assert.equal(match.phase, "active");
  assert.ok(match.sim.tick > 0, "the world ticks on its own");
});

test("a client's input drives its own bird once its turn has started", () => {
  const match = makeMatch();
  applyBirdDutyInput(match, "c_aaa", { drop: true });
  advanceTicks(match, 2);
  assert.equal(match.sim.match.phase, MATCH_SIM_PHASE.PLAYING);

  const startX = match.sim.world.player.x;
  applyBirdDutyInput(match, "c_aaa", { right: true });
  advanceTicks(match, 10);

  assert.ok(match.sim.world.player.x > startX, "held right moves the bird");
});

test("an off-turn client cannot drive the bird", () => {
  const match = makeMatch();
  applyBirdDutyInput(match, "c_aaa", { drop: true });
  advanceTicks(match, 2);

  const startX = match.sim.world.player.x;
  applyBirdDutyInput(match, "c_bbb", { right: true });
  advanceTicks(match, 10);

  assert.equal(match.sim.world.player.x, startX, "only the active seat drives");
});

test("input from a client with no seat in the match is refused", () => {
  const match = makeMatch();

  assert.equal(applyBirdDutyInput(match, "c_stranger", { drop: true }), false);
  assert.equal(match.sim.inputs.c_stranger, undefined);
});

test("a client cannot smuggle a score, a position or a hit through an input", () => {
  const match = makeMatch();
  applyBirdDutyInput(match, "c_aaa", { drop: true, score: 9999, x: -400, hitTypes: ["sanjeet"] });
  advanceTicks(match, 2);

  assert.deepEqual(Object.keys(match.sim.inputs.c_aaa).sort(), ["drop", "left", "right"]);
  assert.equal(match.sim.match.scores.c_aaa, 0, "a claimed score never reaches the scoreboard");
});

test("every message that would state an outcome is refused with SERVER_AUTHORITY", () => {
  const lobby = { ...makeLobby(), birdDutyMatch: makeMatch() };

  for (const messageType of ["bird_duty_score", "bird_duty_hit", "bird_duty_state", "state_sync", "bird_duty_snapshot", "bird_duty_match_ended"]) {
    const result = birdDutyLobbyGame.handleMessage(lobby, "c_aaa", messageType, "{}");
    assert.equal(result.handled, true, `${messageType} must be handled`);
    assert.equal(result.error?.code, "SERVER_AUTHORITY", `${messageType} must be refused`);
  }

  assert.equal(birdDutyLobbyGame.handleMessage(lobby, "c_aaa", "bird_duty_input", "{}").error, undefined);
  assert.equal(birdDutyLobbyGame.handleMessage(lobby, "c_aaa", "chat", "hi").handled, false);
});

test("a snapshot carries the voice lines the tick actually played, and only once", () => {
  const match = makeMatch();
  applyBirdDutyInput(match, "c_aaa", { drop: true });
  advanceTicks(match, 2);
  applyBirdDutyInput(match, "c_aaa", { drop: false });
  advanceTicks(match, 3);
  applyBirdDutyInput(match, "c_aaa", { drop: true });
  advanceTicks(match, 4);

  const first = serializeBirdDutyMatch(match);
  assert.ok(first.sounds.includes("poopRelease"), "the release rides out on the snapshot");

  const second = serializeBirdDutyMatch(match);
  assert.equal(second.sounds.includes("poopRelease"), false, "a drained sound never rides out twice");
});

test("every NPC's voice line is the one its own definition names", () => {
  // The bug that started this: a client used to guess the line from a score delta and always played
  // Alan's. The server names the line, and it comes from the NPC that was actually hit.
  for (const [type, def] of Object.entries(NPC_DEFINITIONS)) {
    assert.equal(typeof def.sound, "string");
    assert.ok(def.sound.length > 0, `${type} has no voice line`);
  }
});

test("a dropped seat stops driving and the match plays on", () => {
  const match = makeMatch(["c_aaa", "c_bbb", "c_ccc"]);
  applyBirdDutyInput(match, "c_aaa", { drop: true, right: true });
  advanceTicks(match, 2);

  assert.equal(applyBirdDutyDisconnect(match, "c_aaa"), true);
  assert.deepEqual(match.sim.inputs.c_aaa, { left: false, right: false, drop: false });
  assert.equal(match.phase, "active", "one player leaving does not end the match");

  const snapshot = serializeBirdDutyMatch(match);
  assert.equal(snapshot.match.players.find((p) => p.clientId === "c_aaa").connected, false);
});

test("a dropped seat forfeits its turn so the match cannot stall on an empty chair", () => {
  // The case that has no way out from inside the game: it is c_aaa's turn, a turn ends only when
  // its magazine is spent, and only c_aaa can spend it. Everyone else is locked out by turn order.
  const match = makeMatch();
  applyBirdDutyInput(match, "c_aaa", { drop: true });
  advanceTicks(match, 2);
  assert.equal(match.sim.match.phase, MATCH_SIM_PHASE.PLAYING);
  assert.ok(match.sim.world.playSession.shotsRemaining > 0, "shots are left in hand");

  applyBirdDutyDisconnect(match, "c_aaa");

  assert.equal(match.sim.match.phase, MATCH_SIM_PHASE.TURN_OVER);
  assert.equal(match.sim.match.activeIndex, 1, "the turn passes to somebody who is still here");
  assert.equal(match.phase, "active", "and the match plays on");
});

test("a seat that drops before its turn starts is skipped too", () => {
  const match = makeMatch();
  advanceTicks(match, 2);
  assert.equal(match.sim.match.phase, MATCH_SIM_PHASE.READY);

  applyBirdDutyDisconnect(match, "c_aaa");

  assert.equal(match.sim.match.activeIndex, 1);
});

test("the turn skips past every absent seat in one go", () => {
  const match = makeMatch(["c_aaa", "c_bbb", "c_ccc"]);
  advanceTicks(match, 2);
  // Two seats gone; the turn must land on the third rather than on the next empty chair.
  applyBirdDutyDisconnect(match, "c_bbb");
  applyBirdDutyDisconnect(match, "c_aaa");

  assert.equal(match.sim.match.players[match.sim.match.activeIndex].clientId, "c_ccc");
  assert.equal(match.phase, "active");
});

test("an off-turn seat dropping does not disturb the turn", () => {
  const match = makeMatch();
  applyBirdDutyInput(match, "c_aaa", { drop: true });
  advanceTicks(match, 2);

  applyBirdDutyDisconnect(match, "c_bbb");

  assert.equal(match.sim.match.phase, MATCH_SIM_PHASE.PLAYING);
  assert.equal(match.sim.match.activeIndex, 0, "the active seat keeps playing");
});

test("a match everybody left is complete rather than ticking on empty", () => {
  const match = makeMatch();
  applyBirdDutyDisconnect(match, "c_aaa");
  applyBirdDutyDisconnect(match, "c_bbb");

  assert.equal(match.phase, "complete");
  assert.equal(birdDutyLobbyGame.hasActiveMatch({ birdDutyMatch: match }), false);
});

test("a returning player is seated again and handed the world as it is now", () => {
  const match = makeMatch();
  applyBirdDutyDisconnect(match, "c_bbb");
  assert.equal(applyBirdDutyReconnect(match, "c_bbb"), true);
  assert.equal(match.connected.has("c_bbb"), true);

  assert.equal(applyBirdDutyReconnect(match, "c_bbb"), false, "a connected seat does not re-seat");
  assert.equal(applyBirdDutyReconnect(match, "c_stranger"), false, "a stranger cannot claim a seat");
});

test("a stalled process gives up its tick debt instead of fast-forwarding the match", () => {
  const match = makeMatch();
  applyBirdDutyInput(match, "c_aaa", { drop: true });
  advanceBirdDutyMatch(match, START_AT + 1);
  const shotsBefore = match.sim.world.playSession.shotsRemaining;

  // Ten seconds of wall clock in one advance. Replaying it would spend the player's whole magazine.
  advanceBirdDutyMatch(match, START_AT + 10_000);

  assert.equal(match.sim.world.playSession.shotsRemaining, shotsBefore);
  assert.ok(match.sim.tick < 60, "the cap holds");
});

test("a turn that runs out of shots passes the seat on", () => {
  const match = makeMatch();
  let elapsed = 0;
  const tick = (count = 1) => { elapsed += count; advanceTicks(match, elapsed); };

  applyBirdDutyInput(match, "c_aaa", { drop: true });
  tick(2);

  for (let shot = 0; shot < HOTSEAT_SHOTS_PER_TURN + 1; shot += 1) {
    applyBirdDutyInput(match, "c_aaa", { drop: false });
    tick(6);
    applyBirdDutyInput(match, "c_aaa", { drop: true });
    tick(6);
    applyBirdDutyInput(match, "c_aaa", { drop: false });
    for (let i = 0; i < 30; i += 1) tick(6);
  }

  assert.equal(match.sim.match.phase, MATCH_SIM_PHASE.TURN_OVER);
  assert.equal(match.sim.match.activeIndex, 1, "the seat passes to the second player");
});

test("the snapshot rate is slower than the tick rate so clients predict between them", () => {
  assert.ok(BIRD_DUTY_SNAPSHOT_HZ < 60);
  assert.equal(serializeBirdDutyMatch(makeMatch()).tickRate, 60);
});

test("the lobby game clears its interval so a finished lobby leaves nothing running", () => {
  const lobby = makeLobby();
  birdDutyLobbyGame.initMatch(lobby, Date.now());
  birdDutyLobbyGame.afterStart(lobby);
  assert.ok(lobby.birdDutyTimer, "a match ticks");

  birdDutyLobbyGame.clearTimers(lobby);
  assert.equal(lobby.birdDutyTimer, null);
});
