import assert from "node:assert/strict";
import test from "node:test";

import { createDisconnectOnce } from "./connection-lifecycle.mjs";

test("an error followed by close only disconnects a socket once", () => {
  const reasons = [];
  const disconnect = createDisconnectOnce((reason) => reasons.push(reason));

  assert.equal(disconnect("error"), true);
  assert.equal(disconnect("disconnect"), false);
  assert.deepEqual(reasons, ["error"]);
});
