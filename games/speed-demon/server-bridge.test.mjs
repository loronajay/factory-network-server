// The Speed Demon bridge, driven end to end through a fake socket layer.
//
// The engine tests cover the rules; these cover the wiring — that both entry
// paths (quick search and a private room code) reach a live match, that the tree
// goes out to both drivers as one instant, that inputs are relayed to the
// opponent and only to the opponent, and that a driver who vanishes does not
// leave the other one staring at a countdown that never resolves.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSpeedDemonServerBridge } from "./server/speed-demon-server-bridge.mjs";
import { definition } from "./server/speed-demon.game.mjs";
import { EVENT_START, EVENT_THROTTLE } from "./shared/input-log.mjs";

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
  if (!condition) throw new Error(message || "Assertion failed");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "shared", "golden-run.json"), "utf8"));

console.log("\nspeed-demon — server bridge");

/** A bridge with every sent message captured, and a clock the test drives. */
function harness() {
  const sent = [];
  let time = 1_000_000;
  let codeSeq = 0;
  const bridge = createSpeedDemonServerBridge({
    now: () => time,
    createRoomCode: () => `ROOM${++codeSeq}`,
    makeSeed: () => 4242,
    sendToClient: (clientId, payload) => sent.push({ clientId, ...payload }),
  });
  return {
    bridge,
    sent,
    advance: (ms) => {
      time += ms;
    },
    /** Every message of one kind, optionally for one client. */
    events: (event, clientId = null) =>
      sent.filter((m) => m.event === event && (clientId === null || m.clientId === clientId)),
    last: (event) => sent.filter((m) => m.event === event).pop() ?? null,
    clear: () => {
      sent.length = 0;
    },
  };
}

const join = (data) => ({ playerId: data.playerId, displayName: data.displayName, ...data });

const roomMessage = (messageType, value) => ({ type: "room_message", messageType, value });

const fastRun = () => golden.events.map((e) => ({ ...e }));
const slowRun = (ticks) =>
  golden.events.map((e) => (e.k === EVENT_START ? { ...e } : { ...e, t: e.t + ticks }));

/** Seats two drivers via quick search and returns the live room. */
function pairedRoom(h) {
  h.bridge.handleClientMessage("c_1", {
    type: "find_match",
    gameId: "speed-demon",
    playerId: "p1",
    displayName: "Ana",
  });
  h.bridge.handleClientMessage("c_2", {
    type: "find_match",
    gameId: "speed-demon",
    playerId: "p2",
    displayName: "Bo",
  });
  return h.bridge.getRoomForClient("c_1");
}

/** Both drivers ready up, race, and report in. */
function playRound(h, logs) {
  h.bridge.handleClientMessage("c_1", roomMessage("ready", { ready: true }));
  h.bridge.handleClientMessage("c_2", roomMessage("ready", { ready: true }));
  const start = h.last("sd_round_start");
  h.advance(60_000);
  for (const [clientId, events] of Object.entries(logs)) {
    h.bridge.handleClientMessage(
      clientId,
      roomMessage("inputs", { round: start.round, attempt: start.attempt, events }),
    );
    h.bridge.handleClientMessage(
      clientId,
      roomMessage("done", { round: start.round, attempt: start.attempt }),
    );
  }
  return h.last("sd_round_result");
}

// ---------------------------------------------------------------------------
// Getting in
// ---------------------------------------------------------------------------

test("the first driver to search waits rather than racing nobody", () => {
  const h = harness();
  h.bridge.handleClientMessage("c_1", { type: "find_match", gameId: "speed-demon", playerId: "p1" });
  assertEqual(h.events("searching", "c_1").length, 1);
  assertEqual(h.events("sd_lobby").length, 0, "no room until there are two of them");
});

test("the second driver to search is paired into a room with the first", () => {
  const h = harness();
  pairedRoom(h);
  const lobbies = h.events("sd_lobby");
  assert(lobbies.length >= 2, "both drivers should be told about the room");
  const forOne = lobbies.filter((m) => m.clientId === "c_1").pop();
  assertEqual(forOne.players.length, 2);
  assertEqual(forOne.players[0].displayName, "Ana");
  assertEqual(forOne.players[1].displayName, "Bo");
});

test("a quick-search race is configured from the seed, not by either driver", () => {
  const h = harness();
  pairedRoom(h);
  const lobby = h.events("sd_lobby", "c_1").pop();
  assert(["quarter", "half"].includes(lobby.config.distanceId), "search sticks to the two lengths");
  assertEqual(lobby.private, false);
});

test("a private room hands back a code and makes its creator the host", () => {
  const h = harness();
  h.bridge.handleClientMessage("c_1", {
    type: "create_room",
    gameId: "speed-demon",
    playerId: "p1",
    displayName: "Ana",
    config: { trackId: "track-c", distanceId: "mile", bestOf: 5 },
  });
  const joined = h.last("room_joined");
  assertEqual(joined.created, true);
  assert(joined.roomCode, "a code is the whole point of a private room");

  const lobby = h.last("sd_lobby");
  assertEqual(lobby.youAreHost, true);
  assertEqual(lobby.config.trackId, "track-c");
  assertEqual(lobby.config.distanceId, "mile", "a private room opens every distance");
  assertEqual(lobby.config.bestOf, 5);
});

test("a second driver joins by code and is not the host", () => {
  const h = harness();
  h.bridge.handleClientMessage("c_1", { type: "create_room", gameId: "speed-demon", playerId: "p1" });
  const code = h.last("room_joined").roomCode;
  h.clear();

  h.bridge.handleClientMessage("c_2", { type: "join_room", roomCode: code, playerId: "p2", displayName: "Bo" });
  const guestLobby = h.events("sd_lobby", "c_2").pop();
  assertEqual(guestLobby.youAreHost, false);
  assertEqual(guestLobby.players.length, 2);
  assertEqual(guestLobby.yourPlayerId, "p2", "each driver is told which car is theirs");
});

test("an unknown room code is refused rather than silently dropped", () => {
  const h = harness();
  h.bridge.handleClientMessage("c_1", { type: "join_room", roomCode: "NOPE1", playerId: "p1" });
  assertEqual(h.last("error").code, "ROOM_NOT_FOUND");
});

test("a third driver is turned away from a full room", () => {
  const h = harness();
  const room = pairedRoom(h);
  h.clear();
  h.bridge.handleClientMessage("c_3", { type: "join_room", roomCode: room.roomCode, playerId: "p3" });
  assertEqual(h.last("error").code, "ROOM_FULL");
});

test("cancelling a search takes the driver out of the queue", () => {
  const h = harness();
  h.bridge.handleClientMessage("c_1", { type: "find_match", gameId: "speed-demon", playerId: "p1" });
  h.bridge.handleClientMessage("c_1", { type: "cancel_match" });
  assertEqual(h.events("search_cancelled", "c_1").length, 1);

  // ...so the next driver in waits rather than being paired with a ghost.
  h.bridge.handleClientMessage("c_2", { type: "find_match", gameId: "speed-demon", playerId: "p2" });
  assertEqual(h.events("searching", "c_2").length, 1);
  assertEqual(h.events("sd_lobby").length, 0);
});

// ---------------------------------------------------------------------------
// The lobby
// ---------------------------------------------------------------------------

test("the host can change the race and the guest sees it", () => {
  const h = harness();
  h.bridge.handleClientMessage("c_1", { type: "create_room", gameId: "speed-demon", playerId: "p1" });
  const code = h.last("room_joined").roomCode;
  h.bridge.handleClientMessage("c_2", { type: "join_room", roomCode: code, playerId: "p2" });
  h.clear();

  h.bridge.handleClientMessage("c_1", roomMessage("config", { distanceId: "half", bestOf: 5 }));
  const guestView = h.events("sd_lobby", "c_2").pop();
  assertEqual(guestView.config.distanceId, "half");
  assertEqual(guestView.config.bestOf, 5);
});

test("a guest trying to change the race is refused", () => {
  const h = harness();
  h.bridge.handleClientMessage("c_1", { type: "create_room", gameId: "speed-demon", playerId: "p1" });
  const code = h.last("room_joined").roomCode;
  h.bridge.handleClientMessage("c_2", { type: "join_room", roomCode: code, playerId: "p2" });
  h.clear();

  h.bridge.handleClientMessage("c_2", roomMessage("config", { distanceId: "mile" }));
  assertEqual(h.last("error").code, "NOT_HOST");
});

test("a driver's car reaches the opponent, so the real thing can be drawn", () => {
  const h = harness();
  pairedRoom(h);
  h.clear();
  h.bridge.handleClientMessage(
    "c_1",
    roomMessage("loadout", { modelId: "kaido-gts", livery: { paint: { hue: 200 } } }),
  );
  const seenByOpponent = h.events("sd_lobby", "c_2").pop();
  const theirCar = seenByOpponent.players.find((player) => player.playerId === "p1");
  assertEqual(theirCar.modelId, "kaido-gts");
  assertEqual(theirCar.livery.paint.hue, 200);
});

// ---------------------------------------------------------------------------
// Racing
// ---------------------------------------------------------------------------

test("both drivers readying up starts one tree, at one instant", () => {
  const h = harness();
  pairedRoom(h);
  h.clear();

  h.bridge.handleClientMessage("c_1", roomMessage("ready", { ready: true }));
  assertEqual(h.events("sd_round_start").length, 0, "one driver ready is not a start");

  h.bridge.handleClientMessage("c_2", roomMessage("ready", { ready: true }));
  const starts = h.events("sd_round_start");
  assertEqual(starts.length, 2, "both drivers are told");
  assertEqual(starts[0].startAt, starts[1].startAt, "and given the same green, to the millisecond");
  assert(starts[0].startAt > starts[0].serverNow, "with time to receive it first");
  assertEqual(starts[0].round, 1);
});

test("inputs are relayed to the opponent and not echoed back", () => {
  const h = harness();
  pairedRoom(h);
  h.bridge.handleClientMessage("c_1", roomMessage("ready", { ready: true }));
  h.bridge.handleClientMessage("c_2", roomMessage("ready", { ready: true }));
  const start = h.last("sd_round_start");
  h.advance(5000);
  h.clear();

  h.bridge.handleClientMessage(
    "c_1",
    roomMessage("inputs", {
      round: start.round,
      attempt: start.attempt,
      events: [{ t: 10, k: EVENT_THROTTLE, v: 1 }],
    }),
  );
  const relayed = h.events("sd_inputs");
  assertEqual(relayed.length, 1, "exactly one recipient");
  assertEqual(relayed[0].clientId, "c_2", "the opponent");
  assertEqual(relayed[0].playerId, "p1", "carrying whose car it is");
  assertEqual(relayed[0].events.length, 1);
});

test("fabricated inputs are neither adjudicated nor relayed", () => {
  const h = harness();
  pairedRoom(h);
  h.bridge.handleClientMessage("c_1", roomMessage("ready", { ready: true }));
  h.bridge.handleClientMessage("c_2", roomMessage("ready", { ready: true }));
  const start = h.last("sd_round_start");
  h.advance(200); // barely off the line
  h.clear();

  h.bridge.handleClientMessage(
    "c_1",
    roomMessage("inputs", {
      round: start.round,
      attempt: start.attempt,
      events: [{ t: 100000, k: EVENT_THROTTLE, v: 1 }],
    }),
  );
  assertEqual(h.events("sd_inputs").length, 0, "a tick the race has not reached goes nowhere");
});

test("a full round is decided by the server's replay and reported to both", () => {
  const h = harness();
  pairedRoom(h);
  h.clear();
  const result = playRound(h, { c_1: fastRun(), c_2: slowRun(30) });

  assertEqual(h.events("sd_round_result").length, 2, "both drivers get the result");
  assertEqual(result.score.players[0].wins, 1);
  const p1 = result.runs.find((run) => run.playerId === "p1");
  assertEqual(p1.finishTime, golden.expected.finishTime, "the server's own number");
});

test("a best-of-three is played out over rounds and ends with a winner", () => {
  const h = harness();
  pairedRoom(h);
  playRound(h, { c_1: fastRun(), c_2: slowRun(30) });
  const final = playRound(h, { c_1: fastRun(), c_2: slowRun(30) });

  assertEqual(final.decided, true);
  assertEqual(final.winnerId, "p1");
  assertEqual(final.score.players[0].wins, 2);
});

test("a round nobody reports is called in by the heartbeat rather than hanging", () => {
  const h = harness();
  pairedRoom(h);
  h.bridge.handleClientMessage("c_1", roomMessage("ready", { ready: true }));
  h.bridge.handleClientMessage("c_2", roomMessage("ready", { ready: true }));
  h.clear();

  h.bridge.tickActiveRooms();
  assertEqual(h.events("sd_round_result").length, 0, "not while the round is still being run");

  h.advance(120_000);
  h.bridge.tickActiveRooms();
  assertEqual(h.events("sd_round_result").length, 2, "a vanished driver must not freeze the tree");
});

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------

test("a driver disconnecting mid-match concedes it to the other", () => {
  const h = harness();
  pairedRoom(h);
  playRound(h, { c_1: fastRun(), c_2: slowRun(30) });
  h.clear();

  h.bridge.handleClientDisconnect("c_1");
  const forfeit = h.last("sd_match_forfeit");
  assert(forfeit, "the remaining driver has to be told the match is over");
  assertEqual(forfeit.winnerId, "p2");
  assertEqual(forfeit.clientId, "c_2", "and told directly");
});

test("a disconnect from the queue just leaves the queue", () => {
  const h = harness();
  h.bridge.handleClientMessage("c_1", { type: "find_match", gameId: "speed-demon", playerId: "p1" });
  h.bridge.handleClientDisconnect("c_1");
  h.bridge.handleClientMessage("c_2", { type: "find_match", gameId: "speed-demon", playerId: "p2" });
  assertEqual(h.events("searching", "c_2").length, 1, "and does not pair the next driver with a ghost");
});

test("an emptied room is thrown away rather than left behind", () => {
  const h = harness();
  const room = pairedRoom(h);
  h.bridge.handleClientDisconnect("c_1");
  h.bridge.handleClientDisconnect("c_2");
  assertEqual(h.bridge.getRoom(room.roomCode), null);
});

// ---------------------------------------------------------------------------
// Rematch
// ---------------------------------------------------------------------------

test("a rematch needs both drivers and then re-opens the lobby", () => {
  const h = harness();
  pairedRoom(h);
  playRound(h, { c_1: fastRun(), c_2: slowRun(30) });
  playRound(h, { c_1: fastRun(), c_2: slowRun(30) });
  h.clear();

  h.bridge.handleClientMessage("c_1", roomMessage("rematch", {}));
  assertEqual(h.last("sd_rematch").started, false, "one driver asking is a request");

  h.bridge.handleClientMessage("c_2", roomMessage("rematch", {}));
  assertEqual(h.last("sd_rematch").started, true);

  const lobby = h.events("sd_lobby").pop();
  assertEqual(lobby.score, null, "a rematch is a new match, with a cleared board");
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The router's contract
// ---------------------------------------------------------------------------

test("the bridge exposes exactly the methods src/router.mjs calls on it", () => {
  // This is not pedantry. `router.mjs` calls `bridge.handleClientMessage(...)`
  // with no guard, so a bridge that names the method anything else throws on the
  // first frame it is handed — inside a `ws` message handler, which takes the
  // whole server process down. It shipped that way once, and every test in this
  // file passed while it did, because they all called the method directly.
  const bridge = harness().bridge;
  for (const method of ["handleClientMessage", "handleClientDisconnect", "tickActiveRooms", "ownsClient", "hasRoomCode"]) {
    assertEqual(typeof bridge[method], "function", `bridge is missing ${method}`);
  }
});

test("the bridge satisfies every bridge call the generic server makes", () => {
  // Read out of the real source rather than restated here, so a call added to
  // the router later fails this test instead of failing in production.
  const routerSource = fs.readFileSync(path.join(__dirname, "..", "..", "src", "router.mjs"), "utf8");
  const registrySource = fs.readFileSync(path.join(__dirname, "..", "registry.mjs"), "utf8");
  const bridge = harness().bridge;

  const called = new Set();
  for (const source of [routerSource, registrySource]) {
    for (const [, method] of source.matchAll(/bridge\.([a-zA-Z]+)\s*\(/g)) called.add(method);
    for (const [, method] of source.matchAll(/instance\.([a-zA-Z]+)\??\s*\(/g)) called.add(method);
  }
  // These two live on the definition, not on the bridge instance.
  called.delete("create");
  called.delete("shouldRoute");

  assert(called.size > 0, "found no bridge calls to check — the scrape is broken");
  for (const method of called) {
    assertEqual(typeof bridge[method], "function", `generic code calls bridge.${method}(), which is missing`);
  }
});

test("a throw inside the bridge costs that client, not the whole server", () => {
  // The router calls handleClientMessage straight out of a `ws` message handler
  // with no guard, so anything escaping this bridge is an unhandled exception in
  // an event emitter — which ends the process and every other match on it.
  const h = harness();
  const room = pairedRoom(h);
  // Sabotage one room's engine the way a real bug would.
  room.engine.startRound = () => {
    throw new Error("boom");
  };
  h.clear();

  h.bridge.handleClientMessage("c_1", roomMessage("ready", { ready: true }));
  h.bridge.handleClientMessage("c_2", roomMessage("ready", { ready: true }));

  assertEqual(h.last("error").code, "INTERNAL", "the client is told, rather than the server dying");
  // ...and the bridge is still working for everyone else.
  h.bridge.handleClientMessage("c_9", { type: "find_match", gameId: "speed-demon", playerId: "p9" });
  assertEqual(h.events("searching", "c_9").length, 1, "other clients must be unaffected");
});

test("the heartbeat survives a room that throws", () => {
  const h = harness();
  const room = pairedRoom(h);
  room.engine.roundIsOver = () => {
    throw new Error("boom");
  };
  h.bridge.tickActiveRooms(); // must not escape: it runs on a shared interval
});

test("two drivers claiming the same id still reach a live match", () => {
  const h = harness();
  h.bridge.handleClientMessage("c_1", {
    type: "find_match", gameId: "speed-demon", playerId: "same", displayName: "Ana",
  });
  h.bridge.handleClientMessage("c_2", {
    type: "find_match", gameId: "speed-demon", playerId: "same", displayName: "Bo",
  });
  h.bridge.handleClientMessage("c_1", roomMessage("ready", { ready: true }));
  h.bridge.handleClientMessage("c_2", roomMessage("ready", { ready: true }));

  assertEqual(h.events("sd_round_start").length, 2, "the tree goes up for both");
  const lobby = h.events("sd_lobby", "c_1").pop();
  assert(
    lobby.players[0].playerId !== lobby.players[1].playerId,
    "and the two lanes are told apart",
  );
});

test("the definition claims its own messages and nobody else's", () => {
  const h = harness();
  const bridge = h.bridge;
  assert(definition.bridge.shouldRoute("c_1", { type: "find_match", gameId: "speed-demon" }, bridge));
  assert(!definition.bridge.shouldRoute("c_1", { type: "find_match", gameId: "sumorai" }, bridge));
  assert(!definition.bridge.shouldRoute("c_1", { type: "room_message" }, bridge), "not for a stranger");
});

test("a private room code routes here even when the join does not name the game", () => {
  const h = harness();
  h.bridge.handleClientMessage("c_1", { type: "create_room", gameId: "speed-demon", playerId: "p1" });
  const code = h.last("room_joined").roomCode;
  assert(
    definition.bridge.shouldRoute("c_2", { type: "join_room", roomCode: code }, h.bridge),
    "sharing a code should be enough on its own",
  );
  assert(
    !definition.bridge.shouldRoute("c_2", { type: "join_room", roomCode: "OTHER" }, h.bridge),
    "but a code this bridge never issued belongs to someone else",
  );
});

test("a client in a room is owned by the bridge, and a stranger is not", () => {
  const h = harness();
  pairedRoom(h);
  assert(h.bridge.ownsClient("c_1"));
  assert(!h.bridge.ownsClient("c_9"));
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
