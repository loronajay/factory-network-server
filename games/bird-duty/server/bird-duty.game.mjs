import { birdDutyLobbyGame } from "./bird-duty-lobby-game.mjs";
import { BIRD_DUTY_GAME_ID } from "./bird-duty-match-engine.mjs";

export const definition = {
  id: BIRD_DUTY_GAME_ID,
  matchmaking: { strategy: "lobby" },
  lobbyGame: birdDutyLobbyGame,
};
