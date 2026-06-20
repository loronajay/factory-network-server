// Build Buddy game definition. A lobby-based (2 player) server-authoritative
// game; its behavior lives in the lobby-game adapter.
import { BUILD_BUDDY_GAME_ID } from "./build-buddy-match-engine.mjs";
import { buildBuddyLobbyGame } from "./build-buddy-lobby-game.mjs";

export const definition = {
  id: BUILD_BUDDY_GAME_ID,
  matchmaking: { strategy: "lobby" },
  lobbyGame: buildBuddyLobbyGame,
};
