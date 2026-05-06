import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadBoardDefinition } from "./shared/circuit-board.mjs";
import { createCircuitSiegeServerBridge } from "./server/circuit-siege-server-bridge.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}: ${error.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function findEvents(outbox, clientId, eventName) {
  return outbox.filter((entry) => entry.clientId === clientId && entry.payload.event === eventName);
}

function findMessages(outbox, clientId, messageType) {
  return outbox.filter((entry) => (
    entry.clientId === clientId
    && entry.payload.event === "message"
    && entry.payload.messageType === messageType
  ));
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gameRoot = __dirname;
const boardPath = path.join(gameRoot, "data", "authored-board.v1.json");
const board = loadBoardDefinition(JSON.parse(fs.readFileSync(boardPath, "utf8")));

function createBridge() {
  const outbox = [];
  const bridge = createCircuitSiegeServerBridge({
    board,
    now: () => 1000,
    createRoomCode: (() => {
      let index = 0;
      return () => `CS0${++index}`;
    })(),
    sendToClient(clientId, payload) {
      outbox.push({ clientId, payload });
    }
  });

  return { bridge, outbox };
}

console.log("\nserver-bridge");

test("queue_status reports blue and red waiting counts", () => {
  const { bridge, outbox } = createBridge();

  bridge.handleClientMessage("c1", { type: "queue_status", gameId: "circuit-siege" });

  const status = findEvents(outbox, "c1", "queue_status")[0];
  assert(status, "expected queue status event");
  assertEqual(status.payload.blueWaiting, 0);
  assertEqual(status.payload.redWaiting, 0);
});

test("find_match pairs opposing queued sides into a room and clears the queue", () => {
  const { bridge, outbox } = createBridge();

  bridge.handleClientMessage("c1", {
    type: "find_match",
    gameId: "circuit-siege",
    side: "blue",
    playerId: "p1",
    displayName: "Blue Pilot"
  });

  bridge.handleClientMessage("c2", {
    type: "find_match",
    gameId: "circuit-siege",
    side: "red",
    playerId: "p2",
    displayName: "Red Pilot"
  });

  assert(findEvents(outbox, "c1", "searching").length === 1, "expected searching event for first player");
  assert(findEvents(outbox, "c1", "room_joined").length === 1, "expected room_joined for blue");
  assert(findEvents(outbox, "c2", "room_joined").length === 1, "expected room_joined for red");
  assert(findEvents(outbox, "c1", "player_joined").length === 1, "expected player_joined for blue");
  assert(findEvents(outbox, "c2", "player_joined").length === 1, "expected player_joined for red");

  const status = findEvents(outbox, "c1", "queue_status").at(-1);
  assertEqual(status.payload.blueWaiting, 0);
  assertEqual(status.payload.redWaiting, 0);
});

test("private join rejects side conflicts and accepts the open opposite side", () => {
  const { bridge, outbox } = createBridge();

  bridge.handleClientMessage("c1", {
    type: "create_room",
    side: "blue",
    playerId: "p1",
    displayName: "Blue Host"
  });

  bridge.handleClientMessage("c2", {
    type: "join_room",
    roomCode: "CS01",
    side: "blue",
    playerId: "p2",
    displayName: "Blue Conflict"
  });

  bridge.handleClientMessage("c3", {
    type: "join_room",
    roomCode: "CS01",
    side: "red",
    playerId: "p3",
    displayName: "Red Guest"
  });

  const conflict = findEvents(outbox, "c2", "error")[0];
  assert(conflict, "expected side conflict error");
  assertEqual(conflict.payload.code, "SIDE_CONFLICT");
  assert(findEvents(outbox, "c3", "room_joined").length === 1, "expected red guest to join room");
});

test("player_ready plus request_start produces match_ready and initial snapshot for both players", () => {
  const { bridge, outbox } = createBridge();

  bridge.handleClientMessage("c1", {
    type: "create_room",
    side: "blue",
    playerId: "p1",
    displayName: "Blue Host"
  });
  bridge.handleClientMessage("c2", {
    type: "join_room",
    roomCode: "CS01",
    side: "red",
    playerId: "p2",
    displayName: "Red Guest"
  });

  bridge.handleClientMessage("c1", { type: "room_message", messageType: "player_ready", value: "true" });
  bridge.handleClientMessage("c2", { type: "room_message", messageType: "player_ready", value: "true" });
  bridge.handleClientMessage("c1", { type: "room_message", messageType: "request_start", value: "" });

  assert(findEvents(outbox, "c1", "match_ready").length === 1, "expected match_ready for blue");
  assert(findEvents(outbox, "c2", "match_ready").length === 1, "expected match_ready for red");

  const blueSnapshot = findMessages(outbox, "c1", "match_snapshot")[0];
  const redSnapshot = findMessages(outbox, "c2", "match_snapshot")[0];
  assert(blueSnapshot, "expected initial snapshot for blue");
  assert(redSnapshot, "expected initial snapshot for red");
});

test("circuit_intent updates the room engine and broadcasts snapshots and route events", () => {
  const { bridge, outbox } = createBridge();

  bridge.handleClientMessage("c1", {
    type: "create_room",
    side: "blue",
    playerId: "p1",
    displayName: "Blue Host"
  });
  bridge.handleClientMessage("c2", {
    type: "join_room",
    roomCode: "CS01",
    side: "red",
    playerId: "p2",
    displayName: "Red Guest"
  });
  bridge.handleClientMessage("c1", { type: "room_message", messageType: "player_ready", value: "true" });
  bridge.handleClientMessage("c2", { type: "room_message", messageType: "player_ready", value: "true" });
  bridge.handleClientMessage("c1", { type: "room_message", messageType: "request_start", value: "" });

  bridge.handleClientMessage("c1", {
    type: "room_message",
    messageType: "circuit_intent",
    value: JSON.stringify({
      intentType: "ROTATE_TILE",
      slotId: "blue_route_01_rp_2"
    })
  });
  bridge.handleClientMessage("c1", {
    type: "room_message",
    messageType: "circuit_intent",
    value: JSON.stringify({
      intentType: "PLACE_TILE",
      slotId: "blue_route_01_rp_1",
      pieceType: "straight",
      rotation: 90
    })
  });
  bridge.handleClientMessage("c1", {
    type: "room_message",
    messageType: "circuit_intent",
    value: JSON.stringify({
      intentType: "PLACE_TILE",
      slotId: "blue_route_01_rp_3",
      pieceType: "straight",
      rotation: 90
    })
  });

  const routeEvents = findMessages(outbox, "c1", "match_event");
  assert(routeEvents.length >= 1, "expected at least one match event");
  const snapshots = findMessages(outbox, "c2", "match_snapshot");
  assert(snapshots.length >= 2, "expected updated snapshots for the opponent");
});

test("disconnecting an active player broadcasts the ended snapshot to the remaining player", () => {
  const { bridge, outbox } = createBridge();

  bridge.handleClientMessage("c1", {
    type: "create_room",
    side: "blue",
    playerId: "p1",
    displayName: "Blue Host"
  });
  bridge.handleClientMessage("c2", {
    type: "join_room",
    roomCode: "CS01",
    side: "red",
    playerId: "p2",
    displayName: "Red Guest"
  });
  bridge.handleClientMessage("c1", { type: "room_message", messageType: "player_ready", value: "true" });
  bridge.handleClientMessage("c2", { type: "room_message", messageType: "player_ready", value: "true" });
  bridge.handleClientMessage("c1", { type: "room_message", messageType: "request_start", value: "" });

  bridge.handleClientDisconnect("c1");

  const endedSnapshots = findMessages(outbox, "c2", "match_snapshot");
  const latest = endedSnapshots.at(-1);
  assert(latest, "expected ended snapshot for remaining player");
  const payload = JSON.parse(latest.payload.value);
  assertEqual(payload.phase, "ended");
  assertEqual(payload.result.reason, "disconnect");
});

test("disconnecting from a lobby emits player_left and keeps the room open for the remaining host", () => {
  const { bridge, outbox } = createBridge();

  bridge.handleClientMessage("c1", {
    type: "create_room",
    side: "blue",
    playerId: "p1",
    displayName: "Blue Host"
  });
  bridge.handleClientMessage("c2", {
    type: "join_room",
    roomCode: "CS01",
    side: "red",
    playerId: "p2",
    displayName: "Red Guest"
  });

  bridge.handleClientDisconnect("c2");

  const playerLeft = findEvents(outbox, "c1", "player_left").at(-1);
  assert(playerLeft, "expected player_left for remaining host");
  assertEqual(playerLeft.payload.playerCount, 1);

  bridge.handleClientMessage("c3", {
    type: "join_room",
    roomCode: "CS01",
    side: "red",
    playerId: "p3",
    displayName: "New Red Guest"
  });

  assert(findEvents(outbox, "c3", "room_joined").length === 1, "expected replacement guest to join");
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}

console.log(`\n${passed} test(s) passed.`);
