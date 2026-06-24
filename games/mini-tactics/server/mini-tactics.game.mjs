// Mini-Tactics game definition. Turn-based isometric squad tactics, 2-4 players
// online (FFA + 2v2 teams).
//
// The match is deterministic LOCKSTEP over the generic v2 lobby relay: there is
// NO server-side match logic here. The lobby hands every client an identical
// ordered `members` array + one shared `seed` at start, and the clients run the
// deterministic core in lockstep from that seed (seat = index in members + 1).
// Board size, format, team colors/names, AND each player's squad composition are
// all exchanged in-band (`config`/`setup` lobby_messages — a blind pick), so they
// intentionally never touch server lobby settings. The lobby owner is the
// authoritative state-hash broadcaster; a divergence is detected, not prevented.
//
// `lobbyGame` is config-only (just `gameId` + `lobbyLimits`): it carries no
// `initMatch`/`handleMessage`/`applyDisconnect`, so every `lobby_message` falls
// through to the generic relay broadcast, `canLobbyStart` is true at >= minPlayers,
// and `lobbyLimitsForGame` caps the room at 2-4 seats. Disconnects use the generic
// lobby `leave` path (no reconnect grace), firing `lobby_player_left` to the rest;
// the remaining clients' owner injects a `concede` command for the dropped seat.
const MINI_TACTICS_GAME_ID = "mini-tactics";

export const definition = {
  id: MINI_TACTICS_GAME_ID,
  matchmaking: { strategy: "lobby" },
  lobbyGame: {
    gameId: MINI_TACTICS_GAME_ID,
    lobbyLimits: { minPlayers: 2, maxPlayers: 4 },
  },
};
