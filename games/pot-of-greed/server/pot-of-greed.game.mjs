import { POT_OF_GREED_GAME_ID } from "./pot-of-greed-match-engine.mjs";
import { potOfGreedLobbyGame } from "./pot-of-greed-lobby-game.mjs";

export const definition = {
  id: POT_OF_GREED_GAME_ID,
  matchmaking: { strategy: "lobby" },
  lobbyGame: potOfGreedLobbyGame,
};
