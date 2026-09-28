// Pondside Push, server-authoritative.
//
// A client may send its pet (before the match) and a direction and a bump
// (during it). Every shove, splash, round and winner is the tick's answer.
import assert from "node:assert/strict";
import test from "node:test";

import { lobbyGame, matchmakingStrategy } from "../registry.mjs";
import { sanitizeLobbySettings } from "../../src/util.mjs";
import { lobbies } from "../../src/state.mjs";
import { pondsidePushLobbyGame } from "./server/pondside-push-lobby-game.mjs";
import {
  PONDSIDE_GAME_ID,
  PONDSIDE_LOBBY_LIMITS,
  advancePondsideMatch,
  applyPondsideDisconnect,
  applyPondsideInput,
  createPondsideMatch,
  serializePondsideMatch,
} from "./server/pondside-push-match-engine.mjs";

const START_AT = 2_000_000;
const TICK_MS = 1000 / 60;

function makeLobby(memberIds = ["c_a", "c_b"], settings = {}) {
  const lobby = {
    roomCode: "PONDS",
    gameId: PONDSIDE_GAME_ID,
    seed: "seed-9",
    status: "open",
    members: new Set(memberIds),
    memberProfiles: new Map(memberIds.map((id, index) => [id, { displayName: `Player ${index + 1}`, playerId: `acct-${index + 1}` }])),
    settings: sanitizeLobbySettings(settings),
  };
  lobbies.set(lobby.roomCode, lobby);
  return lobby;
}

test("the game is a lobby game for two to four pets", () => {
  assert.equal(lobbyGame(PONDSIDE_GAME_ID), pondsidePushLobbyGame);
  assert.deepEqual(matchmakingStrategy(PONDSIDE_GAME_ID), { strategy: "lobby" });
  assert.deepEqual(PONDSIDE_LOBBY_LIMITS, { minPlayers: 2, maxPlayers: 4 });
});

test("CPU guests fill empty chairs up to four, at the host's level", () => {
  const match = createPondsideMatch(makeLobby(["c_a", "c_b"], { cpuCount: 6, cpuLevel: 2 }), START_AT);
  assert.equal(match.session.match.players.length, 4);
  assert.deepEqual(match.session.match.players.filter((player) => player.cpu).map((player) => player.cpu), ["champion", "champion"]);
});

test("a person's direction moves only their own pet once the countdown is over", () => {
  const match = createPondsideMatch(makeLobby(), START_AT);
  let seq = 0;
  let now = START_AT;
  for (let batch = 0; batch < 80; batch += 1) {
    applyPondsideInput(match, "c_a", { inputs: Array.from({ length: 3 }, () => ({ seq: (seq += 1), input: { x: 1, y: 0 } })) });
    now += 3 * TICK_MS;
    advancePondsideMatch(match, now);
  }
  const [mine, theirs] = match.session.match.players;
  assert.ok(mine.vx > 0);
  assert.equal(theirs.vx, 0);
  assert.equal(serializePondsideMatch(match).acks.c_a, seq);
});

test("the server refuses every client-authored outcome", () => {
  const lobby = makeLobby();
  for (const type of ["pondside_state", "pondside_snapshot", "pondside_match_ended", "pondside_splash", "pondside_result", "state_sync"]) {
    assert.equal(pondsidePushLobbyGame.handleMessage(lobby, "c_a", type, "{}").error?.code, "SERVER_AUTHORITY", type);
  }
});

test("a seat that leaves for good goes in the pond; with one seat left, that seat wins", () => {
  const match = createPondsideMatch(makeLobby(), START_AT);
  advancePondsideMatch(match, START_AT + Math.ceil(60 * 5 * TICK_MS));
  applyPondsideDisconnect(match, "c_b", false);
  let now = START_AT + Math.ceil(60 * 5 * TICK_MS);
  let ended = false;
  for (let step = 0; step < 60 * 30 && !ended; step += 3) {
    now += 3 * TICK_MS;
    ended = advancePondsideMatch(match, now);
  }
  assert.equal(ended, true);
  const snapshot = serializePondsideMatch(match);
  assert.equal(snapshot.results[0].seatId, "seat-1");
  assert.equal(snapshot.results[0].accountPlayerId, "acct-1");
});

test("a whole CPU-filled match plays to completion on the server alone", () => {
  const match = createPondsideMatch(makeLobby(["c_a", "c_b"], { cpuCount: 2, cpuLevel: 1 }), START_AT);
  // Two people who never touch the keys: the CPUs push them in and fight it out.
  let now = START_AT;
  let ended = false;
  for (let step = 0; step < 60 * 60 * 10 && !ended; step += 3) {
    now += 3 * TICK_MS;
    ended = advancePondsideMatch(match, now);
  }
  assert.equal(ended, true);
  const snapshot = serializePondsideMatch(match);
  assert.equal(snapshot.results.length, 4);
  assert.equal(snapshot.results[0].wins, 3);
});
