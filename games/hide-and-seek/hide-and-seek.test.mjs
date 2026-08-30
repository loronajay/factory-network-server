import assert from "node:assert/strict";
import test from "node:test";

import { hideAndSeekLobbyGame } from "./server/hide-and-seek-lobby-game.mjs";
import { doesLobbyMatchSearch } from '../../src/lobby.mjs';
import {
  HIDE_AND_SEEK_TICK_RATE,
  advanceHideAndSeekMatch,
  applyHideAndSeekDisconnect,
  applyHideAndSeekInput,
  applyHideAndSeekReconnect,
  chooseSeeker,
  createHideAndSeekMatchState,
  endRoundByDemon,
  serializeHideAndSeekMatch,
} from "./server/hide-and-seek-match-engine.mjs";

const MEMBERS = ["socket-a", "socket-b", "socket-c"];

function lobby(seed = "SEEDA") {
  return {
    roomCode: "HOTEL",
    gameId: "hide-and-seek",
    seed,
    members: new Set(MEMBERS),
    memberProfiles: new Map([
      ["socket-a", { playerId: "factory-a", displayName: "Ana" }],
      ["socket-b", { playerId: "factory-b", displayName: "Bo" }],
      ["socket-c", { playerId: "factory-c", displayName: "Cy" }],
    ]),
    settings: {},
  };
}

const walk = (yaw = Math.PI) => ({ forward: 1, strafe: 0, yaw, crouch: false, sprint: false, light: false });

function run(match, seconds, from = match.startAt) {
  const step = 1000 / HIDE_AND_SEEK_TICK_RATE;
  // Advance in single-tick calls so the per-advance cap never swallows simulated time.
  for (let elapsed = step; elapsed <= seconds * 1000; elapsed += step) advanceHideAndSeekMatch(match, from + elapsed);
  return match;
}

test("a match seats every member, names one seeker and starts them in the head start", () => {
  const match = createHideAndSeekMatchState(lobby(), 1_000);
  const view = serializeHideAndSeekMatch(match, 1_000);

  assert.equal(view.authorityMode, "server");
  assert.equal(view.players.length, 3);
  assert.equal(view.round.phase, "hiding");
  assert.equal(view.players.filter((player) => player.role === "seeker").length, 1);
  assert.equal(view.players.find((player) => player.id === match.seekerId).role, "seeker");
  assert.deepEqual(view.players.map((player) => player.name).sort(), ["Ana", "Bo", "Cy"]);
});

test("the seeker is chosen from the seed, so the same match always picks the same one", () => {
  assert.equal(chooseSeeker(MEMBERS, "SEEDA"), chooseSeeker(MEMBERS, "SEEDA"));
  const picks = new Set(["A", "B", "C", "D", "E", "F", "G", "H"].map((seed) => chooseSeeker(MEMBERS, seed)));
  assert.ok(picks.size > 1, "different seeds should be able to pick different seekers");
  assert.equal(chooseSeeker([], "SEEDA"), null);
});

test("nothing simulates before the scheduled start", () => {
  const match = createHideAndSeekMatchState(lobby(), 10_000);
  advanceHideAndSeekMatch(match, 9_000);

  assert.equal(match.phase, "scheduled");
  assert.equal(serializeHideAndSeekMatch(match).tick, 0);
});

test("an input moves a hider and never carries a position of its own", () => {
  const match = createHideAndSeekMatchState(lobby(), 0);
  const hiderId = MEMBERS.find((id) => id !== match.seekerId);
  const before = serializeHideAndSeekMatch(match).players.find((player) => player.id === hiderId);

  applyHideAndSeekInput(match, hiderId, { ...walk(), x: 999, z: 999, alive: true, flashlight: { charge: 1 } });
  run(match, 2);
  const after = serializeHideAndSeekMatch(match).players.find((player) => player.id === hiderId);

  assert.ok(Math.hypot(after.x - before.x, after.z - before.z) > 1, "the hider should have walked");
  assert.ok(Math.abs(after.x) < 900 && Math.abs(after.z) < 900, "a client-supplied position must be ignored");
});

test("the seeker cannot walk during the head start", () => {
  const match = createHideAndSeekMatchState(lobby(), 0);
  const before = serializeHideAndSeekMatch(match).players.find((player) => player.id === match.seekerId);

  applyHideAndSeekInput(match, match.seekerId, walk());
  run(match, 3);
  const after = serializeHideAndSeekMatch(match).players.find((player) => player.id === match.seekerId);

  assert.deepEqual({ x: after.x, z: after.z }, { x: before.x, z: before.z });
  assert.equal(serializeHideAndSeekMatch(match).round.phase, "hiding");
});

test("a client cannot report its own pose, catch or snapshot", () => {
  const held = { roomCode: "HOTEL", hideAndSeekMatch: createHideAndSeekMatchState(lobby(), 0) };

  for (const messageType of ["hide_and_seek_pose", "hide_and_seek_caught", "hide_and_seek_snapshot", "hide_and_seek_match_ended"]) {
    const result = hideAndSeekLobbyGame.handleMessage(held, "socket-a", messageType, "{}");
    assert.equal(result.handled, true);
    assert.equal(result.error.code, "SERVER_AUTHORITY");
  }
  assert.equal(hideAndSeekLobbyGame.handleMessage(held, "socket-a", "chat", "hi").handled, false);
});

test("a demon catch on the seeker ends the round for the hiders", () => {
  const match = createHideAndSeekMatchState(lobby(), 0);
  endRoundByDemon(match, match.seekerId);
  const view = serializeHideAndSeekMatch(match);

  assert.equal(match.phase, "complete");
  assert.equal(view.round.over, true);
  assert.equal(view.round.outcome, "hiders");
});

test("a dropped seeker settles the round; a dropped hider is left standing", () => {
  const dropped = createHideAndSeekMatchState(lobby(), 0);
  applyHideAndSeekDisconnect(dropped, dropped.seekerId, 1_000);
  assert.equal(dropped.phase, "complete");
  assert.equal(serializeHideAndSeekMatch(dropped).round.outcome, "hiders");

  const match = createHideAndSeekMatchState(lobby(), 0);
  const hiderId = MEMBERS.find((id) => id !== match.seekerId);
  applyHideAndSeekInput(match, hiderId, walk());
  assert.equal(applyHideAndSeekDisconnect(match, hiderId, 1_000), true);
  const at = serializeHideAndSeekMatch(match).players.find((player) => player.id === hiderId);
  run(match, 2);
  const later = serializeHideAndSeekMatch(match).players.find((player) => player.id === hiderId);

  assert.equal(match.phase, "active");
  assert.equal(later.connected, false);
  assert.equal(later.alive, true);
  assert.deepEqual({ x: later.x, z: later.z }, { x: at.x, z: at.z }, "a body nobody is driving stands still");
  assert.equal(applyHideAndSeekReconnect(match, hiderId), true);
  assert.equal(serializeHideAndSeekMatch(match).players.find((player) => player.id === hiderId).connected, true);
});

test("the lobby adapter runs a ticking match and always clears its interval", () => {
  const held = { roomCode: "HOTEL", status: "started" };
  hideAndSeekLobbyGame.initMatch(held, Date.now());
  assert.equal(hideAndSeekLobbyGame.hasActiveMatch(held), true);

  hideAndSeekLobbyGame.afterStart(held);
  assert.ok(held.hideAndSeekTimer, "the match should be ticking");
  hideAndSeekLobbyGame.clearTimers(held);
  assert.equal(held.hideAndSeekTimer, null);

  const started = hideAndSeekLobbyGame.startedPayloadExtras(held, Date.now());
  assert.equal(started.authorityMode, "server");
  assert.equal(started.matchState.players.length, 0);
});

test("the lobby seats between two and eight guests", () => {
  assert.deepEqual(hideAndSeekLobbyGame.lobbyLimits, { minPlayers: 2, maxPlayers: 8 });
  assert.equal(hideAndSeekLobbyGame.gameId, "hide-and-seek");
});

test("the hotel is not empty: two demons hunt, and they walk the same building the clients draw", () => {
  const match = createHideAndSeekMatchState(lobby(), 1_000);
  const opening = serializeHideAndSeekMatch(match, 1_000);

  assert.equal(opening.demons.length, 2, "The Bellhop and The Housekeeper");
  assert.deepEqual(opening.demons.map((entry) => entry.id).sort(), ["bellhop", "housekeeper"]);
  assert.notEqual(opening.demons[0].y, opening.demons[1].y, "they must not open the round on one floor");

  run(match, 20);
  const later = serializeHideAndSeekMatch(match);
  const moved = later.demons.some((entry, index) => Math.hypot(entry.x - opening.demons[index].x, entry.z - opening.demons[index].z) > 2);
  assert.ok(moved, "a demon that never leaves its spawn is not hunting");
  assert.equal(typeof later.threat, "string", "the vignette gets one aggregated state, never a per-demon tracker");
  for (const entry of later.demons) assert.equal("route" in entry, false);
});

test("fixtures are replicated, and a client never asserts one", () => {
  const match = createHideAndSeekMatchState(lobby(), 1_000);
  run(match, 2);
  const view = serializeHideAndSeekMatch(match);

  assert.equal(typeof view.fixtures.elevator.y, "number");
  assert.equal(view.fixtures.elevator.doorAmount, 0, "the cabin is shut around the seeker for the head start");
  assert.equal(typeof view.fixtures.doors, "object");
  assert.ok(Array.isArray(view.pickups));

  // The interact flag is the only thing a client may say about a door, and it is a request.
  assert.equal(applyHideAndSeekInput(match, "socket-b", { forward: 0, interact: true, roomNumber: "105", open: true }), true);
  assert.equal(match.inputs.get("socket-b").interact, true);
  assert.equal("roomNumber" in match.inputs.get("socket-b"), false);
  assert.equal("open" in match.inputs.get("socket-b"), false);
});

test("the head start ends by releasing the cabin, and the seeker walks out of it", () => {
  const match = createHideAndSeekMatchState(lobby(), 1_000);
  for (const id of MEMBERS) applyHideAndSeekInput(match, id, walk());
  run(match, 44);
  assert.equal(serializeHideAndSeekMatch(match).round.phase, "hiding");

  run(match, 50, match.startAt);
  const view = serializeHideAndSeekMatch(match);
  assert.equal(view.round.phase, "seeking");
  assert.ok(view.fixtures.elevator.doorAmount > 0, "the doors start opening exactly on the release");
});

test("a match replays identically from its seed", () => {
  const first = createHideAndSeekMatchState(lobby("REPLAY"), 1_000);
  const second = createHideAndSeekMatchState(lobby("REPLAY"), 1_000);
  for (const id of MEMBERS) {
    applyHideAndSeekInput(first, id, walk(1.1));
    applyHideAndSeekInput(second, id, walk(1.1));
  }
  run(first, 30);
  run(second, 30);

  const a = serializeHideAndSeekMatch(first, 0);
  const b = serializeHideAndSeekMatch(second, 0);
  assert.deepEqual(a.players, b.players);
  assert.deepEqual(a.demons, b.demons, "an authority whose own history cannot be reproduced cannot be audited");
});

test("a reconnecting guest walks back into the body that was left standing", () => {
  const match = createHideAndSeekMatchState(lobby(), 1_000);
  run(match, 46);
  const before = serializeHideAndSeekMatch(match).players.find((player) => player.id === "socket-c");

  assert.equal(applyHideAndSeekDisconnect(match, "socket-c", Date.now()), true);
  const dropped = serializeHideAndSeekMatch(match).players.find((player) => player.id === "socket-c");
  assert.equal(dropped.connected, false);
  assert.equal(dropped.alive, true, "a dropped hider is left standing — a free find, not a vanishing");
  assert.equal(dropped.x, before.x);

  assert.equal(applyHideAndSeekReconnect(match, "socket-c"), true);
  const resumed = serializeHideAndSeekMatch(match).players.find((player) => player.id === "socket-c");
  assert.equal(resumed.connected, true);
  assert.equal(resumed.x, before.x, "they come back where their body was, not at a spawn");

  // The seat is theirs again, so their inputs count again.
  assert.equal(applyHideAndSeekInput(match, "socket-c", walk()), true);
  assert.equal(hideAndSeekLobbyGame.broadcastAfterReconnect({ roomCode: "HOTEL", hideAndSeekMatch: match }), true);
});

test("the map a round is in comes from the lobby, is named in every snapshot, and is never a client's word for it", () => {
  const room = lobby();
  const match = createHideAndSeekMatchState(room, Date.now());
  const snapshot = serializeHideAndSeekMatch(match);
  // A lobby that says nothing plays the default building, and the snapshot names it — a client that
  // built a different one has to be able to refuse the round rather than walk through walls.
  assert.equal(match.mapId, "grand-hotel");
  assert.equal(snapshot.mapId, "grand-hotel");

  // A map id is a lobby setting, so it is untrusted text. Anything that is not a buildable map falls
  // back to the default rather than standing a round up in a building with no geometry.
  for (const mapId of ["atlantis", "", null, { id: "grand-hotel" }]) {
    assert.equal(createHideAndSeekMatchState({ ...room, settings: { mapId } }, Date.now()).mapId, "grand-hotel");
  }

  // A second building the authority can actually run. The lobby names it and the snapshot carries it
  // through, which is what lets a client compare the map it built against the one it is being sent.
  const mall = createHideAndSeekMatchState({ ...room, settings: { mapId: "cinder-mall" } }, Date.now());
  assert.equal(mall.mapId, "cinder-mall");
  assert.equal(serializeHideAndSeekMatch(mall).mapId, "cinder-mall");
});

test("a second map is a second building, not a re-skin of the first", () => {
  const room = lobby();
  const hotel = createHideAndSeekMatchState(room, Date.now());
  const mall = createHideAndSeekMatchState({ ...room, settings: { mapId: "cinder-mall" } }, Date.now());

  // Three demons in the mall against the hotel's two, and the mall's own staff by name.
  assert.deepEqual(mall.state.demons.map((entry) => entry.id), ["greeter", "custodian", "nightwatch"]);
  assert.equal(hotel.state.demons.length, 2);

  // The bodies stand somewhere else entirely, because it is a different building.
  const away = mall.state.bodies.some((body) => hotel.state.bodies.every(
    (other) => Math.hypot(other.x - body.x, other.z - body.z) > 1,
  ));
  assert.equal(away, true, "the mall's spawns must not be the hotel's spawns");

  // And it ticks: sixty seconds of the authority in a building nobody has walked yet.
  let state = mall.state;
  for (let tick = 0; tick < 60 * 60; tick += 1) state = mall.engine.tick(state, 1 / 60, {});
  for (const body of state.bodies) {
    assert.ok(Number.isFinite(body.x) && Number.isFinite(body.z), "a body left the number line");
    assert.ok(body.floor >= 1 && body.floor <= 2, `a body is on floor ${body.floor} of a two-level mall`);
  }
});

test('Mercy matchmaking keeps hospital guests apart from hotel and mall lobbies', () => {
  const room = { ...lobby(), status: 'open', minPlayers: 2, maxPlayers: 8, settings: { mapId: 'mercy-hospital' } };
  assert.equal(doesLobbyMatchSearch(room, 'hide-and-seek', null, { mapId: 'mercy-hospital' }), true);
  for (const mapId of ['grand-hotel', 'cinder-mall']) assert.equal(doesLobbyMatchSearch(room, 'hide-and-seek', null, { mapId }), false);
});

test('Mercy holds the seeker in its own cabin then lets them walk into the hospital', () => {
  const match = createHideAndSeekMatchState({ ...lobby(), settings: { mapId: 'mercy-hospital' } }, 1000);
  // Isolate elevator traversal from catches; demon movement is exercised in the roster replay below.
  match.state.demons = [];
  const initial = { ...match.state.bodies.find(b => b.id === match.seekerId) };
  assert.equal(initial.x, 35.5);
  assert.ok(Math.abs(initial.z - 27.5) < 1);
  applyHideAndSeekInput(match, match.seekerId, walk(0));
  run(match, 44);
  const held = match.state.bodies.find(b => b.id === match.seekerId);
  assert.equal(held.z, initial.z);
  assert.equal(match.state.round.phase, 'hiding');
  run(match, 50);
  const released = match.state.bodies.find(b => b.id === match.seekerId);
  assert.equal(match.state.round.phase, 'seeking');
  assert.ok(released.z < 25, 'the cabin sill or doors trapped the seeker');
  assert.equal(match.space.blocked(released.x, released.z, released.y), false);
});

test("Mercy Hospital seats eight players, replicates its staff, and ticks deterministically", () => {
  const room = { ...lobby('MERCY'), members: new Set(Array.from({ length: 8 }, (_, i) => `guest-${i}`)), settings: { mapId: 'mercy-hospital' } };
  const a = createHideAndSeekMatchState(room, 1000);
  const b = createHideAndSeekMatchState(room, 1000);
  assert.equal(a.mapId, 'mercy-hospital');
  assert.deepEqual(a.state.demons.map(d => d.id), ['surgeon', 'matron', 'orderly']);
  assert.equal(a.state.bodies.length, 8);
  for (const body of a.state.bodies) {
    assert.equal(a.space.blocked(body.x, body.z, body.y), false);
    assert.equal(a.space.groundAt(body.x, body.z, body.y), body.y);
  }
  for (let tick = 0; tick < 60 * 50; tick++) {
    a.state = a.engine.tick(a.state, 1 / 60, {});
    b.state = b.engine.tick(b.state, 1 / 60, {});
  }
  const view = serializeHideAndSeekMatch(a, 51000);
  assert.deepEqual(view, serializeHideAndSeekMatch(b, 51000));
  assert.equal(view.mapId, 'mercy-hospital');
  assert.notEqual(view.round.phase, 'hiding');
  for (const body of [...a.state.bodies, ...a.state.demons]) {
    assert.ok(Number.isFinite(body.x) && Number.isFinite(body.y) && Number.isFinite(body.z));
    assert.ok(body.floor >= 1 && body.floor <= 2);
  }
});

test("the demons in an authoritative round are the map's roster, not a hard-coded pair", () => {
  const match = createHideAndSeekMatchState(lobby(), Date.now());
  const { demons } = serializeHideAndSeekMatch(match);
  assert.deepEqual(demons.map((entry) => entry.id), ["bellhop", "housekeeper"]);
  // Whatever the roster's length, they open apart from each other. Not on floors of their own — the
  // mall carries three demons on two levels, so counting storeys is arithmetic with no answer.
  for (let i = 0; i < match.state.demons.length; i += 1) {
    for (let j = i + 1; j < match.state.demons.length; j += 1) {
      const a = match.state.demons[i];
      const b = match.state.demons[j];
      assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 12 || Math.abs(a.y - b.y) > 1, "two demons opened together");
    }
  }
});
