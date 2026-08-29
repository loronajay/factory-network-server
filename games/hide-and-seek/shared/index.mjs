// The cabinet's pure simulation layer, loaded for the server.
//
// Every file beside this one is a **byte-for-byte copy** from
// `javascript-games/games/hide-and-seek`, produced by that cabinet's
// `tools/mirror-sim.mjs`. Do not edit them here — change the cabinet, re-run the
// tool, and commit both repos. `mirror.test.mjs` fails if a copy is touched.
//
// They are UMD modules: each attaches its API to `globalThis` and, when one
// exists, to `module.exports`. Under this folder's `"type": "module"` there is no
// `module`, so importing one for its side effect is how it is loaded, and the
// global it sets is the API. That is exactly how the browser loads them too —
// classic scripts before the module graph — so the server and the cabinet run the
// same code, not two translations of it.
import "./layout.js";
import "./hotel-plan.js";
import "./collision-logic.js";
import "./movement-logic.js";
import "./round-logic.js";
import "./stamina-logic.js";
import "./sanity-logic.js";
import "./flashlight-logic.js";
import "./enemy-logic.js";
import "./sim-logic.js";

export {
  CONFIG,
  FLOOR_DEFS,
  FLASHLIGHT_CONFIG,
  ROUND_CONFIG,
  SANITY_CONFIG,
  STAMINA_CONFIG,
  floorY,
  keyIdForFloor,
  keyLabelForFloor,
} from "./game-config.js";

export const layout = globalThis.HotelLayout;
export const plan = globalThis.HotelPlan;
export const collision = globalThis.HotelCollision;
export const movement = globalThis.HotelMovement;
export const round = globalThis.HotelRound;
export const stamina = globalThis.HotelStamina;
export const sanity = globalThis.HotelSanity;
export const flashlight = globalThis.HotelFlashlight;
export const enemy = globalThis.HotelEnemyLogic;
export const sim = globalThis.HotelSim;

for (const [name, api] of Object.entries({ layout, plan, collision, movement, round, stamina, sanity, flashlight, enemy, sim })) {
  if (!api) throw new Error(`Hide and Seek shared module "${name}" failed to load`);
}
