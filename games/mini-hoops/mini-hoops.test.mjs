import assert from "node:assert/strict";
import test from "node:test";
import { adjudicateMiniHoopsShot } from "./server/mini-hoops-adjudicator.mjs";
import { miniHoopsLobbyGame } from "./server/mini-hoops-lobby-game.mjs";

import {
  applyMiniHoopsShot,
  createMiniHoopsMatchState,
  finalizeMiniHoopsMatch,
  serializeMiniHoopsMatch,
} from "./server/mini-hoops-match-engine.mjs";

function lobby() {
  return {
    roomCode: "HOOPS",
    gameId: "mini-hoops",
    members: new Set(["socket-a", "socket-b"]),
    memberProfiles: new Map([
      ["socket-a", { playerId: "factory-a", displayName: "Ana" }],
      ["socket-b", { playerId: "factory-b", displayName: "Bo" }],
    ]),
    settings: { modeId: "circle", duration: 30, locationId: "bedroom", ballId: "basketball" },
  };
}

test("creates an account-bound authoritative score duel from host settings", () => {
  const match = createMiniHoopsMatchState(lobby(), 2_000);
  assert.equal(match.authorityMode, "server");
  assert.equal(match.startAt, 2_000);
  assert.equal(match.endsAt, 32_000);
  assert.equal(match.config.modeId, "circle");
  assert.deepEqual(match.players.map((player) => player.accountPlayerId), ["factory-a", "factory-b"]);
});

test("the server adjudicates pull input and ignores claimed scores and winners", () => {
  const match = createMiniHoopsMatchState(lobby(), 2_000);
  const next = applyMiniHoopsShot(match, "socket-a", {
    power: 0.8, aimX: 0, aimY: 1.6, loft: 1, expectedShotNumber: 0,
    score: 999, winnerIds: ["socket-a"],
  }, 3_000, () => ({ scored: true, contacts: ["net"] }));
  assert.equal(next.players[0].score, 2);
  assert.equal(next.players[0].shots, 1);
  assert.deepEqual(next.winnerIds, []);
  assert.equal(next.lastShot.scored, true);
  assert.equal("score" in next.lastShot.intent, false);
});

test("stale shots and shots after the deadline cannot change the result", () => {
  let match = createMiniHoopsMatchState(lobby(), 2_000);
  match = applyMiniHoopsShot(match, "socket-a", { power: 0.8, expectedShotNumber: 0 }, 3_000, () => ({ scored: true }));
  const stale = applyMiniHoopsShot(match, "socket-a", { power: 0.8, expectedShotNumber: 0 }, 3_100, () => ({ scored: true }));
  assert.equal(stale, match);
  const finished = finalizeMiniHoopsMatch(match, 32_000);
  const late = applyMiniHoopsShot(finished, "socket-b", { power: 0.8, expectedShotNumber: 0 }, 32_001, () => ({ scored: true }));
  assert.equal(late, finished);
  assert.deepEqual(finished.winnerIds, ["socket-a"]);
});

test("serialized match exposes server time and authoritative winner", () => {
  let match = createMiniHoopsMatchState(lobby(), 2_000);
  match = applyMiniHoopsShot(match, "socket-a", { power: 0.8, expectedShotNumber: 0 }, 3_000, () => ({ scored: true }));
  const snapshot = serializeMiniHoopsMatch(finalizeMiniHoopsMatch(match, 32_000), 32_100);
  assert.equal(snapshot.authorityMode, "server");
  assert.equal(snapshot.serverNow, 32_100);
  assert.deepEqual(snapshot.result.winnerIds, ["socket-a"]);
});

test("the production adjudicator replays the cabinet reference swish", () => {
  const ruling = adjudicateMiniHoopsShot({
    intent: { power: 0.8, aimX: 480, aimY: 224, loft: 1 },
    config: { modeId: "still", ballId: "basketball" },
    motionSeconds: 0,
  });
  assert.equal(ruling.scored, true);
});

test("a disconnect pauses input until reconnect or forfeit expiry", async () => {
  const { applyMiniHoopsDisconnect, applyMiniHoopsReconnect } = await import("./server/mini-hoops-match-engine.mjs");
  const match = createMiniHoopsMatchState(lobby(), 2_000);
  const paused = applyMiniHoopsDisconnect(match, "socket-b", 3_000);
  assert.equal(paused.phase, "paused");
  assert.equal(applyMiniHoopsShot(paused, "socket-a", { power: 0.8, expectedShotNumber: 0 }, 3_100), paused);
  assert.equal(applyMiniHoopsReconnect(paused, "socket-b").phase, "live");
  const forfeited = applyMiniHoopsDisconnect(paused, "socket-b", 4_000);
  assert.equal(forfeited.phase, "complete");
  assert.deepEqual(forfeited.winnerIds, ["socket-a"]);
});

test("the lobby adapter accepts pulls and refuses client-authored results", () => {
  const room = lobby();
  room.settings.modeId = "still";
  room.miniHoopsMatch = createMiniHoopsMatchState(room, Date.now() - 1000);
  const shot = miniHoopsLobbyGame.handleMessage(room, "socket-a", "mini_hoops_shot", JSON.stringify({
    power: 0.8, aimX: 480, aimY: 224, loft: 1, expectedShotNumber: 0,
  }));
  assert.equal(shot.handled, true);
  assert.equal(room.miniHoopsMatch.players[0].score, 2);

  const forged = miniHoopsLobbyGame.handleMessage(room, "socket-a", "mini_hoops_result", JSON.stringify({ winnerIds: ["socket-a"] }));
  assert.equal(forged.error.code, "SERVER_AUTHORITY");
});
