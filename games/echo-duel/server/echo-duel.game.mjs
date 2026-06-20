// Echo Duel game definition. A lobby-based (2-6 player) server-authoritative
// game; its behavior lives in the lobby-game adapter.
import { ECHO_DUEL_GAME_ID } from "./echo-duel-match-engine.mjs";
import { echoDuelLobbyGame } from "./echo-duel-lobby-game.mjs";

export const definition = {
  id: ECHO_DUEL_GAME_ID,
  matchmaking: { strategy: "lobby" },
  lobbyGame: echoDuelLobbyGame,
};
