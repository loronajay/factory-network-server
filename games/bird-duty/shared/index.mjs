// The cabinet's pure simulation layer, loaded for the server.
//
// Every file under `sim/` is a **byte-for-byte copy** from
// `javascript-games/games/bird-duty`, produced by that cabinet's `tools/mirror-sim.mjs`. Do not
// edit them here — change the cabinet, re-run the tool, and commit both repos. `mirror.test.mjs`
// fails if a copy is touched.
//
// Unlike hide-and-seek's UMD modules these are plain ESM, so they are imported normally; the
// `package.json` beside this file is what lets Node read the `.js` extension as a module.
export {
  BIRD_DUTY_PROTOCOL_VERSION,
  BIRD_DUTY_TICK_RATE,
  MATCH_OVER_LINGER_TICKS,
  MATCH_SIM_PHASE,
  applyMatchSimInput,
  clearMatchSimInput,
  createMatchSimState,
  forfeitMatchSimTurn,
  isMatchSimComplete,
  isMatchSimFinished,
  matchSimActivePlayerId,
  matchSimHasPlayer,
  readMatchSimInput,
  serializeMatchSim,
  tickMatchSim,
} from "./sim/match-sim.js";

export { HOTSEAT_ROUNDS, HOTSEAT_SHOTS_PER_TURN } from "./sim/hotseat-session.js";
export { NPC_DEFINITIONS } from "./sim/npcs.js";
