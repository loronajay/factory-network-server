import assert from "node:assert/strict";
import test from "node:test";

import {
  createMessageRateLimiter,
  isOriginAllowed,
} from "./connection-guard.mjs";

test("message rate limiting allows a burst and resets after its window", () => {
  let now = 1000;
  const limiter = createMessageRateLimiter({ limit: 3, windowMs: 1000, now: () => now });

  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), false);

  now = 2001;
  assert.equal(limiter.take(), true);
});

test("origin checks remain open by default and enforce an opt-in allowlist", () => {
  assert.equal(isOriginAllowed("https://anything.example", []), true);
  assert.equal(isOriginAllowed(undefined, []), true);
  assert.equal(isOriginAllowed("https://arcade.example", ["https://arcade.example"]), true);
  assert.equal(isOriginAllowed("https://evil.example", ["https://arcade.example"]), false);
});
