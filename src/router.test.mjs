import assert from "node:assert/strict";
import test from "node:test";

import { handleClientDisconnect, handleClientMessage } from "./router.mjs";
import {
  clients,
  clientSessionTokens,
  suspendedLobbySessions,
} from "./state.mjs";

function fakeSocket() {
  const payloads = [];
  return {
    OPEN: 1,
    readyState: 1,
    send(value) {
      payloads.push(JSON.parse(value));
    },
    payloads,
  };
}

test("legacy ping keeps its existing pong payload", () => {
  const ws = fakeSocket();
  handleClientMessage("c_ping", ws, Buffer.from(JSON.stringify({ type: "ping" })));
  assert.deepEqual(ws.payloads, [{ event: "pong" }]);
});

test("valid JSON with no message object is rejected without throwing", () => {
  const ws = fakeSocket();
  assert.doesNotThrow(() => handleClientMessage("c_null", ws, Buffer.from("null")));
  assert.equal(ws.payloads.at(-1)?.event, "error");
  assert.equal(ws.payloads.at(-1)?.code, "BAD_MESSAGE");
});

test("a handler failure is contained to the sending client", () => {
  const ws = fakeSocket();
  const frame = {
    type: "find_lobby",
    gameId: "echo-duel",
    settings: null,
  };

  assert.doesNotThrow(() => handleClientMessage("c_bad_settings", ws, Buffer.from(JSON.stringify(frame))));
  assert.equal(ws.payloads.at(-1)?.event, "error");
  assert.equal(ws.payloads.at(-1)?.code, "BAD_MESSAGE");
});

test("disconnect cleanup releases session tokens for clients without a suspended match", () => {
  const clientId = "c_cleanup";
  const ws = fakeSocket();
  clients.set(clientId, ws);
  clientSessionTokens.set(clientId, "s_cleanup");

  try {
    handleClientDisconnect(clientId, "disconnect");
    assert.equal(clients.has(clientId), false);
    assert.equal(suspendedLobbySessions.has(clientId), false);
    assert.equal(clientSessionTokens.has(clientId), false);
  } finally {
    clients.delete(clientId);
    clientSessionTokens.delete(clientId);
    suspendedLobbySessions.delete(clientId);
  }
});
