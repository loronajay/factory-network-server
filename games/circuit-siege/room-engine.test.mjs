import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadBoardDefinition } from "./shared/circuit-board.mjs";
import { expandCompactBoard } from "./shared/board-format.mjs";
import { getExpectedMaskForSlot } from "./shared/route-validator.mjs";
import { createCircuitSiegeRoomEngine } from "./server/circuit-siege-room-engine.mjs";

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

function createEngine(overrides = {}) {
  return createCircuitSiegeRoomEngine({
    board,
    boardId: "canon-v1",
    roomId: "room_1",
    roomCode: "CS01",
    ...overrides
  });
}

function seatStandardPlayers(engine) {
  engine.assignPlayer({
    clientId: "c1",
    playerId: "p1",
    displayName: "Blue Pilot",
    side: "blue"
  });
  engine.assignPlayer({
    clientId: "c2",
    playerId: "p2",
    displayName: "Red Pilot",
    side: "red"
  });
}

console.log("\nroom-engine");

test("assignPlayer seats explicit blue and red players and rejects side conflicts", () => {
  const engine = createEngine();

  const first = engine.assignPlayer({
    clientId: "c1",
    playerId: "p1",
    displayName: "Blue Pilot",
    side: "blue"
  });

  const conflict = engine.assignPlayer({
    clientId: "c2",
    playerId: "p2",
    displayName: "Other Blue",
    side: "blue"
  });

  assertEqual(first.ok, true);
  assertEqual(first.player.side, "blue");
  assertEqual(conflict.ok, false);
  assertEqual(conflict.errorCode, "SIDE_TAKEN");
});

test("startMatch requires both players to be seated and starts immediately once they are present", () => {
  const engine = createEngine();
  seatStandardPlayers(engine);

  const result = engine.startMatch({ now: 1000 });

  assertEqual(result.ok, true);
  assertEqual(engine.getSnapshot().phase, "live");
  assertEqual(engine.getSnapshot().boardId, "canon-v1");
  assertEqual(engine.getSnapshot().startedAt, 1000);
  assertEqual(engine.getSnapshot().endsAt, 301000);
  assertEqual(engine.getSnapshot().timerMsRemaining, 300000);
});

test("applyIntent updates authoritative match state during a live match", () => {
  const engine = createEngine();
  seatStandardPlayers(engine);
  engine.startMatch({ now: 1000 });

  let result = engine.applyIntent({
    clientId: "c1",
    intent: {
      intentType: "ROTATE_TILE",
      slotId: "blue_route_01_rp_2"
    },
    receivedAt: 1100
  });

  assertEqual(result.ok, true);
  assertEqual(result.snapshot.slots.blue_route_01_rp_2.placedMask, getExpectedMaskForSlot(board, "blue_route_01_rp_2"));
  assertEqual(result.snapshot.routes.blue_route_01.completed, false);

  const rp1Intent = pieceIntentFromExpectedMask(getExpectedMaskForSlot(board, "blue_route_01_rp_1"));
  result = engine.applyIntent({
    clientId: "c1",
    intent: {
      intentType: "PLACE_TILE",
      slotId: "blue_route_01_rp_1",
      ...rp1Intent
    },
    receivedAt: 1101
  });

  const rp3Intent = pieceIntentFromExpectedMask(getExpectedMaskForSlot(board, "blue_route_01_rp_3"));
  result = engine.applyIntent({
    clientId: "c1",
    intent: {
      intentType: "PLACE_TILE",
      slotId: "blue_route_01_rp_3",
      ...rp3Intent
    },
    receivedAt: 1102
  });

  assertEqual(result.ok, true);
  assertEqual(result.resolvedRoute.routeId, "blue_route_01");
  assertEqual(result.snapshot.routes.blue_route_01.completed, true);
  assertEqual(result.snapshot.phase, "live");
});

test("a fifth damage route ends the match with a score win result", () => {
  const engine = createEngine({
    initialScores: { blue: 4, red: 0 }
  });
  seatStandardPlayers(engine);
  engine.startMatch({ now: 1000 });

  const route03rp1 = pieceIntentFromExpectedMask(getExpectedMaskForSlot(board, "blue_route_03_rp_1"));
  engine.applyIntent({
    clientId: "c1",
    intent: {
      intentType: "PLACE_TILE",
      slotId: "blue_route_03_rp_1",
      ...route03rp1
    },
    receivedAt: 1001
  });

  const route03rp2 = pieceIntentFromExpectedMask(getExpectedMaskForSlot(board, "blue_route_03_rp_2"));
  engine.applyIntent({
    clientId: "c1",
    intent: {
      intentType: "REPLACE_TILE",
      slotId: "blue_route_03_rp_2",
      ...route03rp2
    },
    receivedAt: 1002
  });

  const route03rp3 = pieceIntentFromExpectedMask(getExpectedMaskForSlot(board, "blue_route_03_rp_3"));
  const result = engine.applyIntent({
    clientId: "c1",
    intent: {
      intentType: "PLACE_TILE",
      slotId: "blue_route_03_rp_3",
      ...route03rp3
    },
    receivedAt: 1003
  });

  assertEqual(result.ok, true);
  assertEqual(result.snapshot.phase, "ended");
  assertEqual(result.snapshot.result.type, "win");
  assertEqual(result.snapshot.result.reason, "score");
  assertEqual(result.snapshot.result.winnerSide, "blue");
  assertEqual(result.snapshot.scores.blue, 5);
});

test("tick resolves timer expiry as a draw when nobody reaches five damage routes", () => {
  const engine = createEngine();
  seatStandardPlayers(engine);
  engine.startMatch({ now: 2000 });

  const result = engine.tick(302001);
  assertEqual(result.ok, true);
  assertEqual(result.snapshot.phase, "ended");
  assertEqual(result.snapshot.result.type, "draw");
  assertEqual(result.snapshot.result.reason, "timer");
});

test("tick awards the higher damage score when the timer expires with unequal progress", () => {
  const engine = createEngine({
    initialScores: { blue: 3, red: 1 }
  });
  seatStandardPlayers(engine);
  engine.startMatch({ now: 2000 });

  const result = engine.tick(302001);
  assertEqual(result.ok, true);
  assertEqual(result.snapshot.phase, "ended");
  assertEqual(result.snapshot.result.type, "win");
  assertEqual(result.snapshot.result.reason, "timer");
  assertEqual(result.snapshot.result.winnerSide, "blue");
  assertEqual(result.snapshot.result.loserSide, "red");
});

test("handleDisconnect ends an active match and awards the remaining player the disconnect result", () => {
  const engine = createEngine();
  seatStandardPlayers(engine);
  engine.startMatch({ now: 1000 });

  const result = engine.handleDisconnect("c1");

  assertEqual(result.ok, true);
  assertEqual(result.snapshot.phase, "ended");
  assertEqual(result.snapshot.result.type, "win");
  assertEqual(result.snapshot.result.reason, "disconnect");
  assertEqual(result.snapshot.result.winnerSide, "red");
  assertEqual(result.snapshot.result.message, "opponent disconnected");
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}

console.log(`\n${passed} test(s) passed.`);
