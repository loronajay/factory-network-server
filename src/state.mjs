// Single in-memory store for the whole server. Every module imports the same
// live Map references from here; nothing in here is reassigned, only mutated.
// No database, no persistence — state is intentionally ephemeral (see CLAUDE.md).

export const PORT = process.env.PORT || 3000;
export const MAX_PLAYERS_PER_ROOM = 2;
export const MATCH_READY_DELAY_MS = 4000;

export const CIRCUIT_SIEGE_GAME_ID = "circuit-siege";
export const BUILD_BUDDY_GAME_ID = "build-buddy";
export const ECHO_DUEL_GAME_ID = "echo-duel";

// Parallel lobby protocol for 2-6 player games such as Echo Duel.
// The room/matchmaking protocol stays 1v1 for Lovers Lost / Battleshits.
export const MAX_LOBBY_PLAYERS = 6;
export const DEFAULT_LOBBY_MIN_PLAYERS = 2;
export const DEFAULT_LOBBY_MAX_PLAYERS = 6;
export const DEFAULT_LOBBY_COUNTDOWN_MS = 20000;
export const LOBBY_START_DELAY_MS = 4000;

// --- 1v1 room + matchmaking state ---
export const clients = new Map();         // clientId -> ws
export const clientRooms = new Map();     // clientId -> roomCode
export const rooms = new Map();           // roomCode -> Set(clientId)
export const roomGameIds = new Map();     // roomCode -> gameId
export const clientSides = new Map();     // clientId -> side
export const matchQueues = new Map();     // gameId or gameId:side -> [clientId, ...]
export const clientQueueWatch = new Map();// clientId -> gameId

// --- v2 lobby state ---
export const lobbies = new Map();         // roomCode -> lobby
export const clientLobbies = new Map();   // clientId -> roomCode
