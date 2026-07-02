// Tactical Arena game definition. Turn-based isometric squad tactics — the
// successor to Mini-Tactics. Online is 1v1 (a 2-player lobby) for now.
//
// Like Mini-Tactics, the match is deterministic LOCKSTEP over the generic v2 lobby
// relay: there is NO server-side match logic here. The lobby hands every client an
// identical ordered `members` array + one shared `seed` at start, and the clients
// run the deterministic core in lockstep from that seed (seat = index in members
// + 1). Board size and each player's squad composition are exchanged in-band
// (`config`/`setup` lobby_messages — a blind pick), so they never touch server
// lobby settings. The lobby owner is the authoritative state-hash broadcaster; a
// divergence is detected, not prevented.
//
// `lobbyGame` is config-only (just `gameId` + `lobbyLimits`): it carries no
// `initMatch`/`handleMessage`/`applyDisconnect`, so every `lobby_message` falls
// through to the generic relay broadcast, `canLobbyStart` is true at >= minPlayers,
// and `lobbyLimitsForGame` caps the room at 2 seats. Disconnects use the generic
// lobby `leave` path; the remaining client's owner injects a `concede` command for
// the dropped seat. When local FFA/teams ships, bump `maxPlayers` to 4 — the relay
// is seat-count-agnostic, so no other server change is needed.
const TACTICAL_ARENA_GAME_ID = "tactical-arena";

export const definition = {
  id: TACTICAL_ARENA_GAME_ID,
  matchmaking: { strategy: "lobby" },
  lobbyGame: {
    gameId: TACTICAL_ARENA_GAME_ID,
    lobbyLimits: { minPlayers: 2, maxPlayers: 2 },
  },
};
