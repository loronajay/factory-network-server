import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A mirror guard, not a unit test.
//
// `shared/sim/` is a byte-for-byte copy of the cabinet's pure simulation layer,
// and the failure mode of any mirror is silent drift: the physics get retuned
// over there, this server keeps adjudicating on the old ones, and it scores
// rack after rack on a table that no longer exists while every suite stays
// green. The manifest is written by the cabinet's `tools/mirror-sim.mjs` and
// committed in both repos. If this fails, re-run that tool in
// `javascript-games/games/shark-hall` and commit the result across.
const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, "shared", "sim");
const manifest = JSON.parse(readFileSync(join(shared, "sim-mirror-manifest.json"), "utf8"));

const hash = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

test("every mirrored simulation file matches the cabinet manifest", () => {
  for (const [name, recorded] of Object.entries(manifest.files)) {
    const copy = readFileSync(join(shared, name), "utf8");
    assert.equal(hash(copy), recorded, `shared/sim/${name} drifted — re-run the cabinet's tools/mirror-sim.mjs`);
  }
});

test("nothing has been added to shared/sim that the manifest does not cover", () => {
  const expected = new Set([...Object.keys(manifest.files), "sim-mirror-manifest.json"]);
  for (const entry of readdirSync(shared)) {
    assert.ok(expected.has(entry), `shared/sim/${entry} is not mirrored from the cabinet`);
  }
});

test("the mirrored layer runs a full break with no renderer present", async () => {
  const { rackBalls } = await import("./shared/sim/balls.js");
  const { createWorld } = await import("./shared/sim/world.js");

  const world = createWorld();
  world.load(rackBalls());
  world.strike({ angle: 0, power: 1, spinX: 0, spinY: 0 });
  let steps = 0;
  while (world.moving && steps < 3600) {
    world.step(1 / 60);
    steps++;
  }

  assert.ok(steps > 0 && steps < 3600, "the break must come to rest");
  assert.notEqual(world.report.firstHit, null, "the break must reach the rack");
  assert.equal(typeof globalThis.document, "undefined");
});

test("the mirror is deterministic across worlds", () => {
  // The property the whole online model rests on: two runs of the same stroke
  // over the same table agree exactly, so the server that scores a shot and the
  // browsers that animate it cannot end up looking at different tables.
  const run = async () => {
    const { rackBalls } = await import("./shared/sim/balls.js");
    const { createWorld } = await import("./shared/sim/world.js");
    const world = createWorld();
    world.load(rackBalls());
    world.strike({ angle: 0.05, power: 0.9, spinX: 0.2, spinY: 0.4 });
    while (world.moving) world.step(1 / 60);
    return world.balls.map((ball) => `${ball.n}:${ball.x.toFixed(9)}:${ball.z.toFixed(9)}:${ball.pocketed}`).join("|");
  };
  return Promise.all([run(), run()]).then(([a, b]) => assert.equal(a, b));
});
