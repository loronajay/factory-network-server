import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBoardCatalog, selectMapEntry } from "./server/board-catalog.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}: ${error.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gameRoot = __dirname;

console.log("\nboard-catalog");

test("selectMapEntry uses random pool selection when the manifest allows it", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(gameRoot, "maps", "index.json"), "utf8"));
  const entry = selectMapEntry(manifest, {
    randomFn: () => 0
  });

  assertEqual(entry.mapId, "canon-v1");
});

test("createBoardCatalog loads a board by map id and preserves its map id", () => {
  const catalog = createBoardCatalog({
    gameDirectory: gameRoot,
    randomFn: () => 0
  });

  const loaded = catalog.loadBoardByMapId("canon-v1");
  assertEqual(loaded.mapEntry.mapId, "canon-v1");
  assertEqual(loaded.board.mapId, "canon-v1");
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}

console.log(`\n${passed} test(s) passed.`);
