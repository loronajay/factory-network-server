import assert from "node:assert/strict";
import test from "node:test";

import { makeId, send } from "./transport.mjs";

test("session identifiers can request stronger entropy without changing legacy client ids", () => {
  assert.match(makeId("c_"), /^c_[0-9a-f]{8}$/);
  assert.match(makeId("s_", 16), /^s_[0-9a-f]{32}$/);
});

test("send closes a slow consumer instead of growing its buffer indefinitely", () => {
  const closes = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 2_000,
    close(code, reason) { closes.push({ code, reason }); },
    send() { throw new Error("should not send while backpressured"); },
  };

  assert.equal(send(ws, { event: "snapshot" }, { maxBufferedAmount: 1_000 }), false);
  assert.deepEqual(closes, [{ code: 1013, reason: "Client is not keeping up" }]);
});

test("send contains socket write failures", () => {
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send() { throw new Error("socket closed between checks"); },
  };
  assert.equal(send(ws, { event: "snapshot" }), false);
});
