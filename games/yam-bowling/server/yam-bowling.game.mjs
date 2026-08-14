import { yamBowlingLobbyGame } from "./yam-bowling-lobby-game.mjs";
import { YAM_BOWLING_GAME_ID } from "./yam-bowling-match-engine.mjs";

export const definition = {
  id: YAM_BOWLING_GAME_ID,
  matchmaking: { strategy: "lobby" },
  lobbyGame: yamBowlingLobbyGame,
};
