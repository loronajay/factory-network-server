import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A mirror guard, not a unit test.
//
// `shared/` is a byte-for-byte copy of the cabinet's pure simulation layer, and the failure mode of
// any mirror is silent drift: the rules get retuned over there, this server keeps adjudicating on
// the old ones, and it decides catches in a hotel that no longer exists while every suite stays
// green. The manifest is written by the cabinet's `tools/mirror-sim.mjs` and committed in both
// repos. If this fails, re-run that tool in
// `javascript-games/games/hide-and-seek` and commit the result across.
const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, "shared");
const manifest = JSON.parse(readFileSync(join(shared, "sim-mirror-manifest.json"), "utf8"));

const hash = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
const basename = (name) => name.slice(name.lastIndexOf("/") + 1);

test("every mirrored simulation file matches the cabinet manifest", () => {
  for (const [name, recorded] of Object.entries(manifest.files)) {
    const copy = readFileSync(join(shared, basename(name)), "utf8");
    assert.equal(hash(copy), recorded, `shared/${basename(name)} drifted — re-run the cabinet's tools/mirror-sim.mjs`);
  }
});

test("nothing has been added to shared/ that the manifest does not cover", () => {
  const expected = new Set([...Object.keys(manifest.files).map(basename), "sim-mirror-manifest.json", "index.mjs"]);
  for (const entry of readdirSync(shared)) {
    assert.ok(expected.has(entry), `shared/${entry} is not mirrored from the cabinet`);
  }
});

test("the mirrored layer loads and builds the hotel with no renderer present", async () => {
  const api = await import("./shared/index.mjs");
  const hotel = api.plan.createHotelPlan({
    config: api.CONFIG, floorDefs: api.FLOOR_DEFS, layout: api.layout,
    floorY: api.floorY, keyIdForFloor: api.keyIdForFloor, keyLabelForFloor: api.keyLabelForFloor,
  });

  assert.ok(hotel.colliders.length > 100);
  assert.ok(hotel.spawns.hiders.length >= 4);
  assert.equal(typeof api.sim.createSimulation, "function");
  assert.equal(typeof globalThis.window, "undefined");
});
