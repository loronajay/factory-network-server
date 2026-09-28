import { pondsidePushLobbyGame } from "./pondside-push-lobby-game.mjs";
import { PONDSIDE_GAME_ID } from "./pondside-push-match-engine.mjs";

export const definition = {
  id: PONDSIDE_GAME_ID,
  matchmaking: { strategy: "lobby" },
  lobbyGame: pondsidePushLobbyGame,
};
