import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECTED_CAPABILITIES,
  PROTOCOL_VERSION,
  validateClientFrame,
} from "./protocol.mjs";

test("the protocol advertises additive server capabilities", () => {
  assert.equal(PROTOCOL_VERSION >= 2, true);
  assert.equal(CONNECTED_CAPABILITIES.includes("lobbies-v2"), true);
  assert.equal(CONNECTED_CAPABILITIES.includes("session-resume"), true);
});

test("all existing top-level message shapes pass common validation", () => {
  const frames = [
    { type: "ping" },
    { type: "find_match", gameId: "speed-demon", side: "p1" },
    { type: "create_room", gameId: "sumorai" },
    { type: "join_room", roomCode: "ABCDE" },
    { type: "room_message", messageType: "input", value: "{}" },
    { type: "direct_message", targetId: "c_12345678", messageType: "hello", value: "world" },
    { type: "find_lobby", gameId: "yam-bowling", settings: { matchType: "quick" } },
    { type: "resume_lobby", clientId: "c_12345678", sessionToken: "s_secret" },
  ];

  for (const frame of frames) assert.deepEqual(validateClientFrame(frame), { ok: true });
});

test("common validation rejects malformed or resource-amplifying fields", () => {
  assert.equal(validateClientFrame(null).ok, false);
  assert.equal(validateClientFrame({}).ok, false);
  assert.equal(validateClientFrame({ type: "x".repeat(65) }).ok, false);
  assert.equal(validateClientFrame({ type: "find_lobby", settings: null }).ok, false);
  assert.equal(validateClientFrame({ type: "find_match", gameId: "g".repeat(65) }).ok, false);
  assert.equal(validateClientFrame({ type: "room_message", messageType: "m".repeat(97) }).ok, false);
});
