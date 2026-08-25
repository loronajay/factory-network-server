import { miniHoopsLobbyGame } from "./mini-hoops-lobby-game.mjs";
import { MINI_HOOPS_GAME_ID } from "./mini-hoops-match-engine.mjs";

export const definition = {
  id: MINI_HOOPS_GAME_ID,
  matchmaking: { strategy: "lobby" },
  lobbyGame: miniHoopsLobbyGame,
};
