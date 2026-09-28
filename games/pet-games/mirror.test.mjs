import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// A mirror guard, not a unit test.
//
// `mirror/` is a byte-for-byte copy of the Pet Games' pure layers (the shared
// rival pool and both events' sims), kept at the same relative paths so their
// imports resolve unchanged. The manifest is written by the cabinet's
// `games/pet-games/tools/mirror-sim.mjs` and committed in both repos. If this
// fails, re-run that tool in javascript-games and commit the result across.
const here = dirname(fileURLToPath(import.meta.url));
const mirror = join(here, "mirror");
const manifest = JSON.parse(readFileSync(join(mirror, "sim-mirror-manifest.json"), "utf8"));
const hash = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test("every mirrored file matches the cabinet manifest", () => {
  for (const [path, recorded] of Object.entries(manifest.files)) {
    assert.equal(hash(readFileSync(join(mirror, path), "utf8")), recorded, `${path} drifted — re-run games/pet-games/tools/mirror-sim.mjs`);
  }
});

test("nothing is in the mirror that the manifest does not cover", () => {
  const expected = new Set([...Object.keys(manifest.files), "sim-mirror-manifest.json", "package.json"]);
  for (const file of walk(mirror)) {
    const path = relative(mirror, file).split("\\").join("/");
    assert.ok(expected.has(path), `mirror/${path} is not mirrored from the cabinet`);
  }
});

test("the mirrored layer is pure enough to run here at all", () => {
  const code = (path) => readFileSync(join(mirror, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*/g, "$1");
  for (const path of Object.keys(manifest.files)) {
    const source = code(path);
    assert.ok(!/\bdocument\b|\bwindow\b|\blocalStorage\b/.test(source), `${path} touches the DOM`);
    assert.ok(!/Date\.now|performance\.now|setTimeout|setInterval/.test(source), `${path} reads a clock`);
    assert.ok(!/Math\.random/.test(source), `${path} uses an ambient random source`);
  }
});
