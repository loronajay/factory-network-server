import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadBoardDefinition } from "./shared/circuit-board.mjs";
import { expandCompactBoard } from "./shared/board-format.mjs";
import { getExpectedMaskForSlot } from "./shared/route-validator.mjs";
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
const boardPath = path.join(gameRoot, "maps", "map-01.json");
const raw = JSON.parse(fs.readFileSync(boardPath, "utf8"));
const board = loadBoardDefinition(raw.grid ? expandCompactBoard(raw) : raw);

function pieceIntentFromExpectedMask(mask) {
  if (mask === "EW") {
    return { pieceType: "straight", rotation: 0 };
  }
  if (mask === "NS") {
    return { pieceType: "straight", rotation: 90 };
  }
  if (mask === "NE") {
    return { pieceType: "corner", rotation: 0 };
  }
  if (mask === "ES") {
    return { pieceType: "corner", rotation: 90 };
  }
  if (mask === "SW") {
    return { pieceType: "corner", rotation: 180 };
  }
  if (mask === "NW") {
    return { pieceType: "corner", rotation: 270 };
  }

  throw new Error(`Unsupported expected mask: ${mask}`);
}

function createBridge() {
  const outbox = [];
  let currentNow = 1000;
  const bridge = createCircuitSiegeServerBridge({
    selectBoard() {
      return {
        mapEntry: {
          mapId: "canon-v1",
          path: "./maps/map-01.json"
        },
        board
      };
    },
    now: () => currentNow,
    createRoomCode: (() => {
      let index = 0;
      return () => `CS0${++index}`;
    })(),
    sendToClient(clientId, payload) {
      outbox.push({ clientId, payload });
    }
  });

  return {
    bridge,
    outbox,
    setNow(nextNow) {
      currentNow = nextNow;
    }
  };
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

test("joining the second player auto-starts the match and sends initial snapshots to both players", () => {
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

  assert(findEvents(outbox, "c1", "match_ready").length === 1, "expected match_ready for blue");
  assert(findEvents(outbox, "c2", "match_ready").length === 1, "expected match_ready for red");
  assertEqual(findEvents(outbox, "c1", "match_ready")[0].payload.mapId, "canon-v1");

  const blueSnapshot = findMessages(outbox, "c1", "match_snapshot")[0];
  const redSnapshot = findMessages(outbox, "c2", "match_snapshot")[0];
  assert(blueSnapshot, "expected initial snapshot for blue");
  assert(redSnapshot, "expected initial snapshot for red");
  assertEqual(JSON.parse(blueSnapshot.payload.value).boardId, "canon-v1");
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

  bridge.handleClientMessage("c1", {
    type: "room_message",
    messageType: "circuit_intent",
    value: JSON.stringify({
      intentType: "ROTATE_TILE",
      slotId: "blue_route_01_rp_2"
    })
  });
  const route01rp1Intent = pieceIntentFromExpectedMask(getExpectedMaskForSlot(board, "blue_route_01_rp_1"));
  bridge.handleClientMessage("c1", {
    type: "room_message",
    messageType: "circuit_intent",
    value: JSON.stringify({
      intentType: "PLACE_TILE",
      slotId: "blue_route_01_rp_1",
      ...route01rp1Intent
    })
  });
  const route01rp3Intent = pieceIntentFromExpectedMask(getExpectedMaskForSlot(board, "blue_route_01_rp_3"));
  bridge.handleClientMessage("c1", {
    type: "room_message",
    messageType: "circuit_intent",
    value: JSON.stringify({
      intentType: "PLACE_TILE",
      slotId: "blue_route_01_rp_3",
      ...route01rp3Intent
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

  bridge.handleClientDisconnect("c1");

  const endedSnapshots = findMessages(outbox, "c2", "match_snapshot");
  const latest = endedSnapshots.at(-1);
  assert(latest, "expected ended snapshot for remaining player");
  const payload = JSON.parse(latest.payload.value);
  assertEqual(payload.phase, "ended");
  assertEqual(payload.result.reason, "disconnect");
});

test("tickActiveRooms broadcasts the timer result when a live room expires", () => {
  const { bridge, outbox, setNow } = createBridge();

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

  setNow(302001);
  bridge.tickActiveRooms();

  const latest = findMessages(outbox, "c1", "match_snapshot").at(-1);
  assert(latest, "expected ended snapshot after ticking active rooms");
  const payload = JSON.parse(latest.payload.value);
  assertEqual(payload.phase, "ended");
  assertEqual(payload.result.reason, "timer");
});

test("disconnecting the waiting host removes the room before any opponent joins", () => {
  const { bridge, outbox } = createBridge();

  bridge.handleClientMessage("c1", {
    type: "create_room",
    side: "blue",
    playerId: "p1",
    displayName: "Blue Host"
  });

  bridge.handleClientDisconnect("c1");

  bridge.handleClientMessage("c2", {
    type: "join_room",
    roomCode: "CS01",
    side: "red",
    playerId: "p2",
    displayName: "Red Guest"
  });

  const error = findEvents(outbox, "c2", "error").at(-1);
  assert(error, "expected room not found after host disconnect");
  assertEqual(error.payload.code, "ROOM_NOT_FOUND");
});

test("a bridge engine failure is contained and returned as a safe error", () => {
  const outbox = [];
  const bridge = createCircuitSiegeServerBridge({
    selectBoard() {
      throw new Error("broken map catalog");
    },
    now: () => 1000,
    createRoomCode: () => "FAIL1",
    sendToClient(clientId, payload) {
      outbox.push({ clientId, payload });
    },
  });

  let escaped = null;
  try {
    bridge.handleClientMessage("c1", {
      type: "create_room",
      gameId: "circuit-siege",
      side: "blue",
    });
  } catch (error) {
    escaped = error;
  }
  assertEqual(escaped, null, "bridge errors must not escape into the WebSocket event loop");
  const error = findEvents(outbox, "c1", "error").at(-1);
  assert(error, "expected a contained error response");
  assertEqual(error.payload.code, "INTERNAL");
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}

console.log(`\n${passed} test(s) passed.`);
