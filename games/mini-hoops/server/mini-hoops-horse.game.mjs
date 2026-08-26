// HORSE is its OWN game id, sharing the cabinet's folder and its mirrored sim.
//
// A separate id rather than a mode flag on `mini-hoops`, for the reason floor
// tic-tac-toe has one: matchmaking is a pool. A player looking for a timed score
// duel and a player looking to spell a word are not each other's opponents, and
// one queue would pair them.
import { horseLobbyGame } from "./horse-lobby-game.mjs";
import { HORSE_GAME_ID } from "./horse-match-engine.mjs";

export const definition = {
  id: HORSE_GAME_ID,
  matchmaking: { strategy: "lobby" },
  lobbyGame: horseLobbyGame,
};
