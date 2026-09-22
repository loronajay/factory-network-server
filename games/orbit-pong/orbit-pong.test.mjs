import test from "node:test";
import assert from "node:assert/strict";

import { createOrbitPongMatch } from "./server/orbit-pong-match.mjs";
import { createOrbitPongServerBridge } from "./server/orbit-pong-server-bridge.mjs";
import { CONFIG, createState, startState, stepState } from "./shared/simulation.mjs";

test("server match accepts commands but owns every outcome field", () => {
  const match = createOrbitPongMatch({ seed: 9 });
  match.addPlayer("client-a", { playerId: "a", displayName: "A" });
  match.addPlayer("client-b", { playerId: "b", displayName: "B" });
  match.setReady("client-a", true);
  match.setReady("client-b", true);
  assert.equal(match.start().ok, true);

  assert.equal(match.setInput("client-a", { sequence: 1, orbit: 8 }).ok, true);
  assert.equal(match.setInput("client-b", { sequence: 2, orbit: -8 }).ok, true);
  const before = match.snapshot();
  match.tick();
  const after = match.snapshot();
  assert.ok(after.paddles[0].angularVelocity > before.paddles[0].angularVelocity);
  assert.ok(after.paddles[1].angularVelocity < before.paddles[1].angularVelocity);
  assert.deepEqual(after.scores, [0, 0]);
  assert.deepEqual(after.acknowledgedSequences, [1, 2]);
});

test("bridge runs private rooms, ready-up, and authoritative snapshots", () => {
  const sent = [];
  const bridge = createOrbitPongServerBridge({
    sendToClient: (clientId, payload) => sent.push({ clientId, payload }),
    createRoomCode: () => "ORBIT",
    makeSeed: () => 42,
    scheduleInterval: null,
  });

  bridge.handleClientMessage("a", { type: "create_room", gameId: "orbit-pong", playerId: "pa", displayName: "A" });
  bridge.handleClientMessage("b", { type: "join_room", gameId: "orbit-pong", roomCode: "ORBIT", playerId: "pb", displayName: "B" });
  bridge.handleClientMessage("a", { type: "room_message", messageType: "ready", value: { ready: true } });
  bridge.handleClientMessage("b", { type: "room_message", messageType: "ready", value: { ready: true } });

  assert.equal(sent.filter((entry) => entry.payload.event === "op_match_started").length, 2);
  bridge.handleClientMessage("a", { type: "room_message", messageType: "input", value: { sequence: 1, orbit: 1 } });
  for (let tick = 0; tick < 4; tick += 1) bridge.tickActiveRooms();
  assert.ok(sent.some((entry) => entry.payload.event === "op_snapshot"));
});

test("bridge refuses client-authored results", () => {
  const sent = [];
  const bridge = createOrbitPongServerBridge({
    sendToClient: (clientId, payload) => sent.push({ clientId, payload }),
    createRoomCode: () => "ABCDE",
    scheduleInterval: null,
  });
  bridge.handleClientMessage("a", { type: "create_room", gameId: "orbit-pong" });
  for (const messageType of ["score", "ball_hit", "match_end", "snapshot"]) {
    bridge.handleClientMessage("a", { type: "room_message", messageType, value: { winnerId: "a", score: 99 } });
  }
  const errors = sent.filter((entry) => entry.payload.code === "SERVER_AUTHORITY");
  assert.equal(errors.length, 4);
});

test("authoritative simulation calls a double touch and awards the opponent", () => {
  const state = createState(5, [
    { playerId: "p1", displayName: "One" },
    { playerId: "p2", displayName: "Two" },
  ]);
  startState(state);
  state.phase = "PLAYING";
  state.paddles[0].angle = 0;
  state.paddles[1].angle = Math.PI;
  Object.assign(state.ball, {
    x: CONFIG.arenaRadius - CONFIG.ballRadius - 2,
    y: 0,
    vx: 900,
    vy: 0,
    lastTouchPlayerId: "p1",
  });

  const events = stepState(state, [{ orbit: 0 }, { orbit: 0 }]);

  assert.deepEqual(state.players.map((player) => player.score), [0, 1]);
  assert.ok(events.some((event) => event.type === "DOUBLE_TOUCH_FAULT" && event.playerId === "p1"));
});
