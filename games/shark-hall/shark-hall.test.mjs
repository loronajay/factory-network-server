import assert from "node:assert/strict";
import test from "node:test";

import { sharkHallLobbyGame } from "./server/shark-hall-lobby-game.mjs";
import {
  DEFAULT_RACE_TO,
  PHASE_COMPLETE,
  PHASE_PAUSED,
  SHARK_HALL_PROTOCOL_VERSION,
  applySharkDisconnect,
  applySharkReconnect,
  applySharkShot,
  breakerForRack,
  createSharkMatchState,
  playShot,
  requestSharkRematch,
  sanitizeRaceTo,
  serializeSharkMatch,
} from "./server/shark-hall-match-engine.mjs";

function lobby(settings = {}) {
  return {
    roomCode: "SHARK",
    gameId: "shark-hall",
    members: new Set(["socket-a", "socket-b"]),
    memberProfiles: new Map([
      ["socket-a", { playerId: "factory-a", displayName: "Ana" }],
      ["socket-b", { playerId: "factory-b", displayName: "Bo" }],
    ]),
    settings: { protocolVersion: SHARK_HALL_PROTOCOL_VERSION, raceTo: 3, ...settings },
  };
}

const BREAK = { seq: 0, angle: 0, power: 1, spinX: 0, spinY: 0 };

/** A ball, at rest, where the test wants it. */
const at = (n, x, z) => ({ n, x, z, vx: 0, vz: 0, wx: 0, wy: 0, wz: 0, pocketed: false });

// A cut into the near side pocket, staged rather than found by search so a
// geometry change that moves a pocket fails these tests loudly instead of
// quietly potting something else. It is a CUT and not a straight shot on
// purpose: the cue ball follows a straight pot into the same pocket, which
// scores as a scratch on the 8 and hands the rack to the other seat.
const BALL_RADIUS = 0.028575;
const SIDE_POT_Z = 0.535;
const CUE_SPOT = { x: -0.6, z: 0.25 };
const CUT_AT_SIDE = {
  angle: Math.atan2(SIDE_POT_Z - 2 * BALL_RADIUS - CUE_SPOT.z, 0 - CUE_SPOT.x),
  power: 0.4,
  spinX: 0,
  spinY: 0,
};

// ---------------------------------------------------------------------------
// Opening a match
// ---------------------------------------------------------------------------

test("seats come from the lobby in join order and the host breaks the first rack", () => {
  const match = createSharkMatchState(lobby(), 2_000);
  assert.deepEqual(match.seats.map((seat) => seat.name), ["Ana", "Bo"]);
  assert.deepEqual(match.seats.map((seat) => seat.playerId), ["factory-a", "factory-b"]);
  assert.equal(match.shooter, 0);
  assert.equal(match.breaker, 0);
  assert.equal(match.isBreak, true);
  assert.equal(match.rackNumber, 1);
  assert.equal(match.balls.length, 16);
});

test("the race length is the host's, clamped to the offered lengths", () => {
  assert.equal(createSharkMatchState(lobby({ raceTo: 5 })).raceTo, 5);
  assert.equal(createSharkMatchState(lobby({ raceTo: 4 })).raceTo, DEFAULT_RACE_TO);
  assert.equal(sanitizeRaceTo("nonsense"), DEFAULT_RACE_TO);
  assert.equal(sanitizeRaceTo(1), 1);
});

test("racks alternate the break", () => {
  assert.equal(breakerForRack(1), 0);
  assert.equal(breakerForRack(2), 1);
  assert.equal(breakerForRack(3), 0);
});

// ---------------------------------------------------------------------------
// The authority line
// ---------------------------------------------------------------------------

test("the server plays the shot and the table moves", () => {
  const match = createSharkMatchState(lobby());
  const before = match.balls.map((ball) => ball.x);
  const played = applySharkShot(match, "socket-a", BREAK);

  assert.equal(played.error, null);
  assert.equal(played.match.shotSeq, 1);
  assert.equal(played.match.isBreak, false);
  assert.notDeepEqual(played.match.balls.map((ball) => ball.x), before);
  // The stroke and the table it was played on are what the clients replay.
  assert.deepEqual(Object.keys(played.shot.stroke).sort(), ["angle", "power", "spinX", "spinY"]);
  assert.equal(played.shot.ballsBefore.length, 16);
});

test("the same stroke on the same table always answers the same way", () => {
  const one = applySharkShot(createSharkMatchState(lobby()), "socket-a", BREAK);
  const two = applySharkShot(createSharkMatchState(lobby()), "socket-a", BREAK);
  assert.deepEqual(one.match.balls, two.match.balls);
  assert.deepEqual(one.shot.outcome, two.shot.outcome);
});

test("only the shooter may shoot, and only at the table they were shown", () => {
  const match = createSharkMatchState(lobby());
  assert.equal(applySharkShot(match, "socket-b", BREAK).error.code, "NOT_YOUR_TURN");
  assert.equal(applySharkShot(match, "socket-c", BREAK).error.code, "NOT_SEATED");
  // The replay guard: a stroke aimed at an older table is refused outright,
  // which is what stops a doubled click from playing twice.
  assert.equal(applySharkShot(match, "socket-a", { ...BREAK, seq: 7 }).error.code, "STALE_SHOT");
});

test("a stroke of nonsense is coerced rather than trusted", () => {
  const match = createSharkMatchState(lobby());
  const played = applySharkShot(match, "socket-a", {
    seq: 0, angle: 1e9, power: 99, spinX: 50, spinY: -50,
  });
  assert.equal(played.error, null);
  assert.ok(Math.abs(played.shot.stroke.angle) <= Math.PI);
  assert.equal(played.shot.stroke.power, 1);
  assert.ok(Math.hypot(played.shot.stroke.spinX, played.shot.stroke.spinY) <= 1.0001);
});

test("the adapter refuses every message that would state an outcome", () => {
  for (const messageType of ["shark_match", "shark_match_ended", "shark_shot_played", "shark_result"]) {
    const result = sharkHallLobbyGame.handleMessage({ roomCode: "SHARK" }, "socket-a", messageType, "{}");
    assert.equal(result.error.code, "SERVER_AUTHORITY", messageType);
  }
});

test("an unknown message is left for the generic relay", () => {
  const result = sharkHallLobbyGame.handleMessage({ roomCode: "SHARK" }, "socket-a", "chat", "{}");
  assert.equal(result.handled, false);
});

// ---------------------------------------------------------------------------
// Rules and racks
// ---------------------------------------------------------------------------

test("a rack won short of the race opens the next one with the break alternated", () => {
  const match = {
    ...createSharkMatchState(lobby({ raceTo: 3 })),
    isBreak: false,
    groups: ["solid", "stripe"],
    balls: [at(0, CUE_SPOT.x, CUE_SPOT.z), at(8, 0, SIDE_POT_Z)],
  };
  const played = applySharkShot(match, "socket-a", { seq: 0, ...CUT_AT_SIDE });

  assert.equal(played.error, null);
  assert.equal(played.match.seats[0].wins, 1);
  assert.equal(played.match.matchWinner, null);
  assert.equal(played.match.rackNumber, 2);
  assert.equal(played.match.breaker, 1, "the second rack is broken by the other seat");
  assert.equal(played.match.shooter, 1);
  assert.equal(played.match.isBreak, true);
  assert.equal(played.match.balls.length, 16, "a fresh triangle");
});

test("the race ends the match once a seat reaches the target", () => {
  const match = {
    ...createSharkMatchState(lobby({ raceTo: 1 })),
    isBreak: false,
    groups: ["solid", "stripe"],
    balls: [at(0, CUE_SPOT.x, CUE_SPOT.z), at(8, 0, SIDE_POT_Z)],
  };
  const played = applySharkShot(match, "socket-a", { seq: 0, ...CUT_AT_SIDE });

  assert.equal(played.match.phase, PHASE_COMPLETE);
  assert.equal(played.match.matchWinner, 0);
  assert.match(played.match.message, /Ana wins the match/);
});

test("ball in hand honours the shooter's placement and clamps it into the zone", () => {
  // The grant itself is the rules layer's business and is tested in the cabinet.
  // What belongs here is what the server does with the placement a client sends,
  // which is to pull it to the nearest legal spot rather than refuse a turn the
  // shooter is already holding the ball for.
  const scratched = {
    ...createSharkMatchState(lobby()),
    isBreak: false,
    ballInHand: "kitchen",
    shooter: 1,
    groups: ["solid", "stripe"],
    balls: [at(0, -0.8, 0), at(9, 0.4, 0)],
  };

  const clamped = applySharkShot(scratched, "socket-b", {
    seq: 0, angle: 0, power: 0.3, spinX: 0, spinY: 0, place: { x: 0.9, z: 0.2 },
  });
  assert.equal(clamped.error, null);
  const spotted = clamped.shot.ballsBefore.find((ball) => ball.n === 0);
  assert.ok(spotted.x <= -0.635, "a placement past the head string is pulled back into the kitchen");
  assert.equal(clamped.match.ballInHand, "none", "the grant is spent by the shot");

  const honoured = applySharkShot(scratched, "socket-b", {
    seq: 0, angle: 0, power: 0.3, spinX: 0, spinY: 0, place: { x: -0.9, z: 0.25 },
  });
  const where = honoured.shot.ballsBefore.find((ball) => ball.n === 0);
  assert.ok(Math.hypot(where.x + 0.9, where.z - 0.25) < 1e-9, "a legal placement is taken as sent");
});

test("the 8 on the break is a rerack, not a result", () => {
  const match = {
    ...createSharkMatchState(lobby()),
    balls: [at(0, CUE_SPOT.x, CUE_SPOT.z), at(8, 0, SIDE_POT_Z)],
  };
  const played = applySharkShot(match, "socket-a", { seq: 0, ...CUT_AT_SIDE });

  assert.equal(played.match.matchWinner, null);
  assert.deepEqual(played.match.seats.map((seat) => seat.wins), [0, 0]);
  assert.equal(played.match.rackNumber, 1, "the same rack, broken again");
  assert.equal(played.match.breaker, 0, "by the same player");
  assert.equal(played.match.balls.length, 16);
});

test("playShot always comes to rest", () => {
  const match = createSharkMatchState(lobby());
  const played = playShot(match.balls, { angle: 0, power: 1, spinX: 0, spinY: 0.9 });
  assert.ok(played.steps > 0);
  assert.ok(played.steps < 3600, "a shot that never settles would be a stuck match");
  assert.ok(played.report.firstHit !== null);
});

// ---------------------------------------------------------------------------
// Connection and rematch
// ---------------------------------------------------------------------------

test("a drop holds the table, and a reconnect resumes it", () => {
  const match = createSharkMatchState(lobby());
  const dropped = applySharkDisconnect(match, "socket-b", 1_000);
  assert.equal(dropped.phase, PHASE_PAUSED);
  assert.equal(dropped.seats[1].connected, false);
  assert.equal(applySharkShot(dropped, "socket-a", BREAK).error.code, "MATCH_PAUSED");

  const back = applySharkReconnect(dropped, "socket-b", 2_000);
  assert.equal(back.phase, "aiming");
  assert.equal(back.seats[1].connected, true);
  assert.equal(applySharkShot(back, "socket-a", BREAK).error, null);
});

test("a second drop for the same seat hands the match to whoever is still standing", () => {
  const match = createSharkMatchState(lobby({ raceTo: 3 }));
  const gone = applySharkDisconnect(applySharkDisconnect(match, "socket-b", 1_000), "socket-b", 50_000);
  assert.equal(gone.phase, PHASE_COMPLETE);
  assert.equal(gone.matchWinner, 0);
  assert.equal(gone.seats[0].wins, 3);
});

test("a rematch needs both seats and resets the score, not the seats", () => {
  const finished = { ...createSharkMatchState(lobby()), phase: PHASE_COMPLETE, matchWinner: 0 };
  finished.seats = finished.seats.map((seat, index) => ({ ...seat, wins: index === 0 ? 3 : 1 }));

  const one = requestSharkRematch(finished, "socket-a");
  assert.equal(one.started, false);
  assert.equal(one.match.seats[0].rematch, true);

  const both = requestSharkRematch(one.match, "socket-b");
  assert.equal(both.started, true);
  assert.equal(both.match.phase, "aiming");
  assert.deepEqual(both.match.seats.map((seat) => seat.wins), [0, 0]);
  assert.deepEqual(both.match.seats.map((seat) => seat.name), ["Ana", "Bo"]);
  assert.equal(both.match.rackNumber, 1);
  assert.equal(both.match.shotSeq, 0);
});

// ---------------------------------------------------------------------------
// The wire and the gate
// ---------------------------------------------------------------------------

test("the serialized match carries the table and the score, and never the live state", () => {
  const match = createSharkMatchState(lobby());
  const wire = serializeSharkMatch(match, 9_000);
  assert.equal(wire.serverNow, 9_000);
  assert.equal(wire.raceTo, 3);
  assert.equal(wire.shooterId, "socket-a");
  assert.equal(wire.balls.length, 16);
  assert.deepEqual(wire.seats.map((seat) => seat.wins), [0, 0]);
  wire.balls[0].x = 99;
  assert.notEqual(match.balls[0].x, 99, "the wire copy must not alias the match");
});

test("a lobby will not start until both seats announce this protocol", () => {
  const room = lobby();
  assert.equal(sharkHallLobbyGame.canStart(room), false);
  sharkHallLobbyGame.handleMessage(room, "socket-a", "shark_profile", JSON.stringify({ protocolVersion: SHARK_HALL_PROTOCOL_VERSION }));
  assert.equal(sharkHallLobbyGame.canStart(room), false, "one seat is not both");
  sharkHallLobbyGame.handleMessage(room, "socket-b", "shark_profile", JSON.stringify({ protocolVersion: SHARK_HALL_PROTOCOL_VERSION }));
  assert.equal(sharkHallLobbyGame.canStart(room), true);

  room.settings.protocolVersion = 99;
  assert.equal(sharkHallLobbyGame.canStart(room), false);
});

test("the lobby seats exactly two", () => {
  assert.deepEqual(sharkHallLobbyGame.lobbyLimits, { minPlayers: 2, maxPlayers: 2 });
});
