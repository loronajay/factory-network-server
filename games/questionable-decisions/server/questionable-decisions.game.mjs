import { QD_GAME_ID } from "./qd-match-engine.mjs";
import { questionableDecisionsLobbyGame } from "./qd-lobby-game.mjs";

export const definition = {
  id: QD_GAME_ID,
  matchmaking: { strategy: "lobby" },
  lobbyGame: questionableDecisionsLobbyGame,
};
