// The Arcade Room presence bridge, driven through a fake socket layer.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CHAT_WINDOW_MS,
  MAX_CHATS_PER_WINDOW,
  MAX_CHAT_LENGTH,
  MAX_MEMBERS_PER_ROOM,
  MIN_CHAT_INTERVAL_MS,
  MIN_EMOTE_INTERVAL_MS,
  MIN_POSE_INTERVAL_MS,
  STALE_MEMBER_MS,
  createArcadeRoomPresenceBridge,
  sanitizePose,
} from "./server/arcade-room-presence-bridge.mjs";
import { definition } from "./server/arcade-room.game.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function harness() {
  const sent = [];
  let time = 1_000_000;
  const bridge = createArcadeRoomPresenceBridge({
    now: () => time,
    sendToClient: (clientId, payload) => sent.push({ ...payload, to: clientId }),
  });
  return {
    bridge,
    sent,
    advance: (ms) => { time += ms; },
    clear: () => { sent.length = 0; },
    events: (event, to) => sent.filter((m) => m.event === event && (!to || m.to === to)),
  };
}

function join(h, clientId, roomId, identity = {}, pose = {}, sessionId = `session-${clientId}`) {
  h.bridge.handleClientMessage(clientId, {
    type: "arcade_room_join",
    roomId,
    sessionId,
    identity: { playerId: `p-${clientId}`, displayName: clientId.toUpperCase(), avatarId: "avatar.hero-m", ...identity },
    pose,
  });
}

test("the definition claims only arcade_room_* frames", () => {
  assert.equal(definition.id, "arcade-room");
  assert.equal(definition.matchmaking.strategy, "self-owned");
  assert.equal(definition.bridge.shouldRoute("c_1", { type: "arcade_room_join" }), true);
  assert.equal(definition.bridge.shouldRoute("c_1", { type: "arcade_room_pose" }), true);
  assert.equal(definition.bridge.shouldRoute("c_1", { type: "ping" }), false);
  assert.equal(definition.bridge.shouldRoute("c_1", { type: "find_match", gameId: "arcade-room" }), false);
});

test("joining an arcade hands the joiner the roster and tells everyone else", () => {
  const h = harness();
  join(h, "c_1", "owner-1", {}, { x: 1, z: 2, yaw: 0.5 });
  assert.deepEqual(h.events("arcade_room_joined", "c_1")[0].members, []);
  h.clear();

  join(h, "c_2", "owner-1", { displayName: "Dewkybot" });
  const joined = h.events("arcade_room_joined", "c_2")[0];
  assert.equal(joined.roomId, "owner-1");
  assert.equal(joined.members.length, 1);
  assert.equal(joined.members[0].clientId, "c_1");
  assert.equal(joined.members[0].displayName, "C_1");
  assert.deepEqual(joined.members[0].pose, { x: 1, z: 2, yaw: 0.5, moving: false, activity: "" });

  const arrival = h.events("arcade_room_member_joined", "c_1")[0];
  assert.equal(arrival.member.clientId, "c_2");
  assert.equal(arrival.member.displayName, "Dewkybot");
  assert.equal(h.events("arcade_room_member_joined", "c_2").length, 0, "the joiner is not told about itself");
  assert.equal(h.bridge.ownsClient("c_2"), true);
});

test("two different arcades never hear each other", () => {
  const h = harness();
  join(h, "c_1", "owner-1");
  join(h, "c_2", "owner-2");
  h.clear();
  h.bridge.handleClientMessage("c_1", { type: "arcade_room_pose", x: 3, z: 3, yaw: 1 });
  assert.equal(h.events("arcade_room_pose").length, 0);
  assert.equal(h.bridge.roomCount(), 2);
});

test("a pose is relayed to the rest of the arcade, sanitized, and rate limited", () => {
  const h = harness();
  join(h, "c_1", "owner-1");
  join(h, "c_2", "owner-1");
  join(h, "c_3", "owner-1");
  h.clear();

  h.advance(MIN_POSE_INTERVAL_MS);
  h.bridge.handleClientMessage("c_1", { type: "arcade_room_pose", x: "4.5", z: 999, yaw: NaN, moving: true, activity: "playing Bird Duty" });
  const relayed = h.events("arcade_room_pose");
  assert.deepEqual(relayed.map((m) => m.to).sort(), ["c_2", "c_3"]);
  assert.equal(relayed[0].x, 4.5);
  assert.equal(relayed[0].z, 100, "clamped to the pose limit");
  assert.equal(relayed[0].yaw, 0, "NaN falls back to the previous yaw");
  assert.equal(relayed[0].moving, true);
  assert.equal(relayed[0].activity, "playing Bird Duty");
  h.clear();

  h.advance(MIN_POSE_INTERVAL_MS / 2);
  h.bridge.handleClientMessage("c_1", { type: "arcade_room_pose", x: 5, z: 5, yaw: 0 });
  assert.equal(h.events("arcade_room_pose").length, 0, "a pose inside the minimum interval is dropped");

  h.advance(MIN_POSE_INTERVAL_MS);
  h.bridge.handleClientMessage("c_1", { type: "arcade_room_pose", x: 5, z: 5, yaw: 0 });
  assert.equal(h.events("arcade_room_pose").length, 2);
  assert.equal(h.bridge.roomMembers("owner-1").find((m) => m.clientId === "c_1").pose.x, 5, "the roster remembers the latest pose");
});

test("a pose from a client outside any arcade is refused", () => {
  const h = harness();
  h.bridge.handleClientMessage("c_9", { type: "arcade_room_pose", x: 0, z: 0, yaw: 0 });
  assert.equal(h.events("error", "c_9")[0].code, "NOT_IN_ROOM");
});

test("an emote is relayed to the others and unknown ones are refused", () => {
  const h = harness();
  join(h, "c_1", "owner-1");
  join(h, "c_2", "owner-1");
  h.clear();
  h.bridge.handleClientMessage("c_1", { type: "arcade_room_emote", emote: "wave" });
  assert.equal(h.events("arcade_room_emote", "c_2")[0].emote, "wave");
  assert.equal(h.events("arcade_room_emote", "c_1").length, 0);
  h.bridge.handleClientMessage("c_1", { type: "arcade_room_emote", emote: "<script>" });
  assert.equal(h.events("error", "c_1")[0].code, "BAD_MESSAGE");
});

test("the four picture emotes relay too, and a member cannot fire them faster than the interval", () => {
  const h = harness();
  join(h, "c_1", "owner-1");
  join(h, "c_2", "owner-1");
  h.clear();
  for (const emote of ["heart", "middle-finger", "smile", "crying"]) {
    h.advance(MIN_EMOTE_INTERVAL_MS);
    h.bridge.handleClientMessage("c_1", { type: "arcade_room_emote", emote });
  }
  assert.deepEqual(h.events("arcade_room_emote", "c_2").map((event) => event.emote), ["heart", "middle-finger", "smile", "crying"]);
  h.clear();
  h.advance(MIN_EMOTE_INTERVAL_MS - 1);
  h.bridge.handleClientMessage("c_1", { type: "arcade_room_emote", emote: "heart" });
  assert.equal(h.events("arcade_room_emote", "c_2").length, 0);
  assert.equal(h.events("error", "c_1")[0].code, "TOO_FAST");
  // Another member's clock is their own.
  h.bridge.handleClientMessage("c_2", { type: "arcade_room_emote", emote: "smile" });
  assert.equal(h.events("arcade_room_emote", "c_1")[0].emote, "smile");
});

test("a chat line is relayed to the others with the sender's name, trimmed and bounded", () => {
  const h = harness();
  join(h, "c_1", "owner-1", { displayName: "Jay" });
  join(h, "c_2", "owner-1");
  join(h, "c_3", "owner-2");
  h.clear();
  h.bridge.handleClientMessage("c_1", { type: "arcade_room_chat", text: "  gg   everyone \n <b>hi</b>  " });
  const heard = h.events("arcade_room_chat", "c_2");
  assert.equal(heard.length, 1);
  assert.deepEqual(heard[0], {
    event: "arcade_room_chat",
    roomId: "owner-1",
    clientId: "c_1",
    displayName: "Jay",
    text: "gg everyone <b>hi</b>",
    at: 1_000_000,
    to: "c_2",
  });
  // The sender draws its own line locally; the other arcade never hears it.
  assert.equal(h.events("arcade_room_chat", "c_1").length, 0);
  assert.equal(h.events("arcade_room_chat", "c_3").length, 0);

  h.clear();
  h.advance(MIN_CHAT_INTERVAL_MS);
  h.bridge.handleClientMessage("c_1", { type: "arcade_room_chat", text: "x".repeat(MAX_CHAT_LENGTH + 50) });
  assert.equal(h.events("arcade_room_chat", "c_2")[0].text.length, MAX_CHAT_LENGTH);

  h.clear();
  h.advance(MIN_CHAT_INTERVAL_MS);
  h.bridge.handleClientMessage("c_1", { type: "arcade_room_chat", text: "   " });
  assert.equal(h.events("error", "c_1")[0].code, "BAD_MESSAGE");
  assert.equal(h.events("arcade_room_chat", "c_2").length, 0);

  h.bridge.handleClientMessage("c_9", { type: "arcade_room_chat", text: "hello?" });
  assert.equal(h.events("error", "c_9")[0].code, "NOT_IN_ROOM");
});

test("chat is rate limited per member: a burst is dropped, not relayed, and the window recovers", () => {
  const h = harness();
  join(h, "c_1", "owner-1");
  join(h, "c_2", "owner-1");
  h.clear();
  // Two lines inside the minimum interval: the second is dropped.
  h.bridge.handleClientMessage("c_1", { type: "arcade_room_chat", text: "one" });
  h.bridge.handleClientMessage("c_1", { type: "arcade_room_chat", text: "two" });
  assert.deepEqual(h.events("arcade_room_chat", "c_2").map((m) => m.text), ["one"]);
  assert.equal(h.events("error", "c_1")[0].code, "TOO_FAST");

  // Spaced lines pass until the window budget is spent.
  h.clear();
  for (let i = 0; i < MAX_CHATS_PER_WINDOW + 2; i += 1) {
    h.advance(MIN_CHAT_INTERVAL_MS);
    h.bridge.handleClientMessage("c_1", { type: "arcade_room_chat", text: `line ${i}` });
  }
  assert.equal(h.events("arcade_room_chat", "c_2").length, MAX_CHATS_PER_WINDOW - 1);
  assert.ok(h.events("error", "c_1").every((m) => m.code === "TOO_FAST"));

  // Once the window has passed the member may speak again.
  h.clear();
  h.advance(CHAT_WINDOW_MS);
  h.bridge.handleClientMessage("c_1", { type: "arcade_room_chat", text: "back" });
  assert.equal(h.events("arcade_room_chat", "c_2")[0].text, "back");
});

test("leaving and disconnecting both tell the arcade, and an empty arcade is forgotten", () => {
  const h = harness();
  join(h, "c_1", "owner-1");
  join(h, "c_2", "owner-1");
  h.clear();
  h.bridge.handleClientMessage("c_1", { type: "arcade_room_leave" });
  assert.equal(h.events("arcade_room_member_left", "c_2")[0].clientId, "c_1");
  assert.equal(h.bridge.ownsClient("c_1"), false);

  h.bridge.handleClientDisconnect("c_2", "close");
  assert.equal(h.bridge.ownsClient("c_2"), false);
  assert.equal(h.bridge.roomCount(), 0);
});

test("a reconnect (same player, same session, new socket) replaces the stale member instead of cloning it", () => {
  const h = harness();
  join(h, "c_watcher", "owner-1");
  join(h, "c_old", "owner-1", { playerId: "p-same" }, { x: 1, z: 1 }, "session-phone");
  h.clear();

  // The phone's socket died silently; the page reconnects on a fresh clientId with the same session.
  join(h, "c_new", "owner-1", { playerId: "p-same" }, { x: 4, z: 4 }, "session-phone");
  assert.deepEqual(h.events("arcade_room_member_left", "c_watcher").map((e) => [e.clientId, e.reason]), [["c_old", "replaced"]]);
  assert.equal(h.events("arcade_room_member_joined", "c_watcher")[0].member.clientId, "c_new");
  assert.equal(h.bridge.ownsClient("c_old"), false);
  const roster = h.bridge.roomMembers("owner-1").map((m) => m.clientId).sort();
  assert.deepEqual(roster, ["c_new", "c_watcher"]);
  assert.equal(h.events("arcade_room_joined", "c_new")[0].members.length, 1, "the joiner sees only the watcher, never its own ghost");
  assert.equal("sessionId" in h.events("arcade_room_joined", "c_new")[0].members[0], false, "sessions are never published");

  // Two tabs on one account are two sessions and both stay.
  h.clear();
  join(h, "c_tab2", "owner-1", { playerId: "p-same" }, {}, "session-laptop-tab-2");
  assert.equal(h.events("arcade_room_member_left").length, 0);
  assert.equal(h.bridge.roomMembers("owner-1").length, 3);

  // Without a session id nothing is guessed at.
  h.clear();
  join(h, "c_nosession", "owner-1", { playerId: "p-same" }, {}, "");
  assert.equal(h.events("arcade_room_member_left").length, 0);
});

test("a member nobody has heard from is swept out, and a live one is not", () => {
  const h = harness();
  join(h, "c_1", "owner-1");
  join(h, "c_2", "owner-1");
  h.clear();
  h.advance(STALE_MEMBER_MS - 1000);
  h.bridge.handleClientMessage("c_1", { type: "arcade_room_pose", x: 1, z: 1, yaw: 0 });
  h.bridge.tickActiveRooms();
  assert.equal(h.bridge.roomMembers("owner-1").length, 2, "nobody is stale yet");

  h.advance(2000);
  h.bridge.tickActiveRooms();
  assert.deepEqual(h.bridge.roomMembers("owner-1").map((m) => m.clientId), ["c_1"], "the silent one is gone, the one who moved stays");
  assert.deepEqual(h.events("arcade_room_member_left", "c_1").map((e) => [e.clientId, e.reason]), [["c_2", "timeout"]]);
  assert.equal(h.bridge.ownsClient("c_2"), false);

  // The swept client's next pose earns NOT_IN_ROOM, which is the cue to rejoin.
  h.clear();
  h.bridge.handleClientMessage("c_2", { type: "arcade_room_pose", x: 1, z: 1, yaw: 0 });
  assert.equal(h.events("error", "c_2")[0].code, "NOT_IN_ROOM");
});

test("joining another arcade moves the client and the old arcade hears a leave", () => {
  const h = harness();
  join(h, "c_1", "owner-1");
  join(h, "c_2", "owner-1");
  h.clear();
  join(h, "c_2", "owner-2");
  assert.equal(h.events("arcade_room_member_left", "c_1")[0].reason, "moved");
  assert.equal(h.bridge.roomMembers("owner-1").length, 1);
  assert.equal(h.bridge.roomMembers("owner-2").length, 1);
});

test("an arcade is capped, and a bad roomId is refused", () => {
  const h = harness();
  for (let i = 0; i < MAX_MEMBERS_PER_ROOM; i += 1) join(h, `c_${i}`, "owner-1");
  h.clear();
  join(h, "c_extra", "owner-1");
  assert.equal(h.events("error", "c_extra")[0].code, "ROOM_FULL");
  assert.equal(h.bridge.ownsClient("c_extra"), false);

  join(h, "c_bad", "");
  assert.equal(h.events("error", "c_bad")[0].code, "BAD_MESSAGE");
  join(h, "c_long", "x".repeat(200));
  assert.equal(h.events("error", "c_long")[0].code, "BAD_MESSAGE");
});

test("identity is trimmed and bounded, never trusted", () => {
  const h = harness();
  join(h, "c_1", "owner-1");
  h.clear();
  join(h, "c_2", "owner-1", { displayName: "   " + "n".repeat(60), avatarId: 42 });
  const member = h.events("arcade_room_member_joined", "c_1")[0].member;
  assert.equal(member.displayName.length, 24);
  assert.equal(member.avatarId, "");
  join(h, "c_3", "owner-1", { displayName: "" });
  assert.equal(h.events("arcade_room_member_joined", "c_1")[1].member.displayName, "Player");
});

test("sanitizePose keeps a previous pose under garbage", () => {
  const previous = { x: 1, z: 2, yaw: 3, moving: true, activity: "" };
  assert.deepEqual(sanitizePose({ x: "no", moving: "yes", activity: 12 }, previous), { x: 1, z: 2, yaw: 3, moving: false, activity: "" });
  assert.deepEqual(sanitizePose(null), { x: 0, z: 0, yaw: 0, moving: false, activity: "" });
});

test("the bridge satisfies every bridge call the generic server makes", () => {
  const routerSource = fs.readFileSync(path.join(__dirname, "..", "..", "src", "router.mjs"), "utf8");
  const registrySource = fs.readFileSync(path.join(__dirname, "..", "registry.mjs"), "utf8");
  const bridge = harness().bridge;
  const called = new Set();
  for (const source of [routerSource, registrySource]) {
    for (const [, method] of source.matchAll(/bridge\.([a-zA-Z]+)\s*\(/g)) called.add(method);
    for (const [, method] of source.matchAll(/instance\.([a-zA-Z]+)\??\s*\(/g)) called.add(method);
  }
  called.delete("create");
  called.delete("shouldRoute");
  assert.ok(called.size > 0, "found no bridge calls to check");
  for (const method of called) {
    assert.equal(typeof bridge[method], "function", `generic code calls bridge.${method}(), which is missing`);
  }
});

test("a throw inside the bridge costs that client, not the whole server", () => {
  const sent = [];
  let calls = 0;
  const bridge = createArcadeRoomPresenceBridge({
    sendToClient: (clientId, payload) => {
      calls += 1;
      if (calls === 1) throw new Error("socket exploded");
      sent.push({ ...payload, to: clientId });
    },
  });
  bridge.handleClientMessage("c_1", { type: "arcade_room_join", roomId: "owner-1" });
  assert.equal(sent.find((m) => m.to === "c_1")?.code, "INTERNAL");
  bridge.handleClientMessage("c_2", { type: "arcade_room_join", roomId: "owner-1" });
  assert.equal(sent.find((m) => m.to === "c_2" && m.event === "arcade_room_joined")?.roomId, "owner-1");
});
