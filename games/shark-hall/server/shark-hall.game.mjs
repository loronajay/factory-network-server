import { sharkHallLobbyGame } from "./shark-hall-lobby-game.mjs";
import { SHARK_HALL_GAME_ID } from "./shark-hall-match-engine.mjs";

export const definition = {
  id: SHARK_HALL_GAME_ID,
  matchmaking: { strategy: "lobby" },
  lobbyGame: sharkHallLobbyGame,
};
