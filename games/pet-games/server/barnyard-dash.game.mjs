import { barnyardDashLobbyGame } from "./barnyard-dash-lobby-game.mjs";
import { BARNYARD_GAME_ID } from "./barnyard-dash-match-engine.mjs";

export const definition = {
  id: BARNYARD_GAME_ID,
  matchmaking: { strategy: "lobby" },
  lobbyGame: barnyardDashLobbyGame,
};
