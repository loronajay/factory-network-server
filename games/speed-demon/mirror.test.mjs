import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A mirror guard, not a unit test — the hide-and-seek pattern.
//
// `shared/` and `shared/circuit/` are byte-for-byte copies of the cabinet's pure
// layers. The circuit copy was once a hand-written re-implementation instead,
// and it drifted: it lacked the wall-separation nudge and ran a roster eight
// cars behind, so the server's car parted from every client's prediction on
// the first barrier scrape. The manifest is written by the cabinet's
// `tools/mirror-sim.mjs`; if this fails, re-run that tool in
// `javascript-games/games/speed-demon` and commit the result across.
const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, "shared");
const manifest = JSON.parse(readFileSync(join(shared, "sim-mirror-manifest.json"), "utf8"));

const hash = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

test("every mirrored file matches the cabinet manifest", () => {
  for (const [name, recorded] of Object.entries(manifest.files)) {
    const copy = readFileSync(join(shared, name), "utf8");
    assert.equal(hash(copy), recorded, `shared/${name} drifted — re-run the cabinet's tools/mirror-sim.mjs`);
  }
});

test("nothing has been added to shared/circuit/ that the manifest does not cover", () => {
  const expected = new Set(Object.keys(manifest.files)
    .filter((name) => name.startsWith("circuit/"))
    .map((name) => name.slice("circuit/".length)));
  for (const entry of readdirSync(join(shared, "circuit"))) {
    assert.ok(expected.has(entry), `shared/circuit/${entry} is not mirrored from the cabinet`);
  }
});

test("the server owns no circuit physics of its own", () => {
  // Everything under shared/ that is not mirrored is a server-only helper, and
  // the only one allowed to exist for the circuit is the PNG decoder that
  // feeds the mirrored road mask.
  const mirrored = new Set(Object.keys(manifest.files));
  const allowed = new Set(["circuit-road-mask.mjs", "sim-mirror-manifest.json", "golden-run.json", "circuit-golden.json", "circuit"]);
  for (const entry of readdirSync(shared)) {
    assert.ok(mirrored.has(entry) || allowed.has(entry), `shared/${entry} is neither mirrored nor a known helper`);
  }
});
