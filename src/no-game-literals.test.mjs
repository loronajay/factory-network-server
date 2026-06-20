// Guardrail: generic server code (src/*.mjs) must never name a specific game.
// All game knowledge belongs in games/<id>/ behind the registry. If this test
// fails, you reintroduced a special-case — move it into a Game Definition
// instead of branching on a gameId in shared code. See CLAUDE.md "Adding a game".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// gameIds the server knows about today. The check is substring-based so families
// like "creature-battler-fire" are covered by "creature-battler".
const FORBIDDEN_GAME_IDS = [
  "circuit-siege",
  "echo-duel",
  "build-buddy",
  "sumorai",
  "creature-battler",
  "cockpit-swarm",
];

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}: ${error.message}`);
    failed++;
  }
}

console.log("\ngeneric code is game-agnostic");

test("no gameId literals appear in any src/*.mjs (non-test) module", () => {
  const files = fs.readdirSync(__dirname)
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"));

  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(__dirname, file), "utf8");
    for (const gameId of FORBIDDEN_GAME_IDS) {
      if (text.includes(gameId)) offenders.push(`${file} contains "${gameId}"`);
    }
  }

  if (offenders.length > 0) {
    throw new Error(`generic code references specific games:\n    ${offenders.join("\n    ")}`);
  }
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
