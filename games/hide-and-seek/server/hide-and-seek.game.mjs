import { hideAndSeekLobbyGame } from "./hide-and-seek-lobby-game.mjs";
import { HIDE_AND_SEEK_GAME_ID } from "./hide-and-seek-match-engine.mjs";

export const definition = {
  id: HIDE_AND_SEEK_GAME_ID,
  matchmaking: { strategy: "lobby" },
  lobbyGame: hideAndSeekLobbyGame,
};
