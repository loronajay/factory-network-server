import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A mirror guard, not a unit test.
//
// `shared/sim/` is a byte-for-byte copy of the cabinet's pure simulation layer, and the failure mode
// of any mirror is silent drift: a hitbox gets retuned over there, this server keeps adjudicating on
// the old one, and it scores match after match in a world that no longer exists while every suite
// stays green. The manifest is written by the cabinet's `tools/mirror-sim.mjs` and committed in both
// repos. If this fails, re-run that tool in `javascript-games/games/bird-duty` and commit the result
// across.
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

test("the mirrored layer is pure enough to run here at all", () => {
  // The same rule the cabinet's `tests/modules.test.mjs` enforces, asserted again on this side. A
  // DOM reference or a clock read would either throw on the server or — worse — not throw, and
  // quietly make the two copies disagree about a match in progress.
  const code = (name) =>
    readFileSync(join(shared, name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*/g, "$1");

  for (const name of Object.keys(manifest.files)) {
    const source = code(name);
    assert.ok(!/\bdocument\b|\bwindow\b|\blocalStorage\b/.test(source), `${name} touches the DOM`);
    assert.ok(!/Date\.now|performance\.now|setTimeout|setInterval/.test(source), `${name} reads a clock`);
    assert.ok(!/Math\.random/.test(source), `${name} uses an ambient random source`);
  }
});

test("the mirrored match runs a full turn under node with nothing else present", async () => {
  const { createMatchSimState, tickMatchSim, matchSimActivePlayerId, MATCH_SIM_PHASE } =
    await import("./shared/sim/match-sim.js");

  let state = createMatchSimState({
    players: [{ clientId: "a", name: "A" }, { clientId: "b", name: "B" }],
  });
  assert.equal(matchSimActivePlayerId(state), "a");

  state = tickMatchSim(state, { a: { drop: true } });
  assert.equal(state.match.phase, MATCH_SIM_PHASE.PLAYING);

  for (let i = 0; i < 600; i += 1) state = tickMatchSim(state, { a: { drop: i % 40 === 0 } });
  assert.ok(state.tick > 600, "the world advanced");
});
