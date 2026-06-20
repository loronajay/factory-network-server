# factory-network-server

Real-time WebSocket multiplayer backend for **JayArcade** games. Handles rooms, matchmaking, and message relay. Modular Node.js (ESM) server; `server.mjs` is a thin bootstrap that delegates to focused modules under `src/` and `games/`.

## Scope

This server is responsible for **multiplayer only** — connecting players, managing rooms, and relaying game messages. It has no database and no persistence by design.

**Do not** add leaderboard logic, score storage, or HTTP REST endpoints for game data to this server. That belongs to `leaderboard-server` (separate Railway service, separate repo).

## Sibling Services

| Service | Responsibility | Repo |
|---|---|---|
| `factory-network-server` | Real-time WebSocket multiplayer | `full-games/factory-network-server` |
| `leaderboard-server` | Global leaderboard REST API + Postgres | `full-games/leaderboard-server` |

Both live in the same Railway project but are fully independent. Work is never mixed between them.

## Hosting
- Deployed on **Railway** (same project as `leaderboard-server`)
- Port read from `process.env.PORT` (Railway sets this automatically)
- Local dev: port 3000

## Stack
- **Node.js** (ESM, `.mjs`) + **Express 5** + **ws** (WebSocket library)
- No database — all state is in-memory, intentionally ephemeral
- Entry point: `server.mjs` (bootstrap only)
- Start: `npm start`

## Architecture / Module Map

`server.mjs` wires Express + ws and delegates everything. The concerns that used
to live in one 2,300-line file are now split:

| Path | Responsibility |
|---|---|
| `server.mjs` | Bootstrap: HTTP routes, WS connection wiring, `listen` |
| `src/state.mjs` | The single in-memory store (all Maps + constants) |
| `src/transport.mjs` | `send`, `sendToClient`, id + room-code helpers |
| `src/util.mjs` | Pure sanitizers/helpers (no state dependency) |
| `src/matchmaking.mjs` | Queues, sides, `match_ready`, `queue_status` |
| `src/rooms.mjs` | 1v1 room lifecycle (join/leave/broadcast) |
| `src/lobby.mjs` | Generic v2 lobby lifecycle (game-agnostic) |
| `src/router.mjs` | WebSocket message dispatch table |
| `games/registry.mjs` | Maps gameId → game integration |
| `games/<game>/server/*` | Per-game server logic |

**Two game integration styles** (both fronted by `games/registry.mjs`):
1. **Self-owning bridge** — `circuit-siege` owns its own rooms/queues and
   intercepts messages (`shouldRouteToCircuitSiege` / `getCircuitSiegeBridge`).
2. **Lobby game-module** — `echo-duel` and `build-buddy` plug into the generic
   lobby via the interface documented at the top of `src/lobby.mjs`. Each game has
   a pure `*-match-engine.mjs` (state transitions + serializers) and a
   `*-lobby-game.mjs` adapter (timers, broadcasting, lobby wiring).

`src/lobby.mjs` is intentionally free of game-specific identifiers; anything
game-specific is delegated to the module returned by `lobbyGame(gameId)`.

Note: the `src/*` and `games/*` adapters import each other (rooms↔lobby,
lobby↔registry↔adapters). These cycles are safe because the shared bindings are
only used inside function bodies; the registry's lobby-game map is built lazily
to avoid touching adapter bindings during their temporal dead zone.

## In-Memory State

All of the following live in `src/state.mjs` and are imported wherever needed.

| Variable | Type | Purpose |
|---|---|---|
| `clients` | `Map<clientId, ws>` | All connected WebSocket clients |
| `clientRooms` | `Map<clientId, roomCode>` | Which room each client is in |
| `clientSides` | `Map<clientId, side>` | Remembered side/role for side-aware matchmaking and private-room validation |
| `clientQueueWatch` | `Map<clientId, gameId>` | Which game's queue counts this client wants live updates for |
| `rooms` | `Map<roomCode, Set<clientId>>` | Members of each room |
| `matchQueues` | `Map<queueKey, clientId[]>` | Matchmaking queues keyed by `gameId` or `gameId:side` |

- `MAX_PLAYERS_PER_ROOM = 2`
- `clientId` format: `c_<8 hex chars>` (e.g. `c_1a2b3c4d`)
- Room codes: 5 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no ambiguous chars)

## WebSocket Protocol

### Client → Server (message `type`)

| type | fields | behavior |
|---|---|---|
| `create_room` | optional `side` | Leaves current room if any, creates new room, joins it |
| `join_room` | `roomCode`, optional `side` | Join existing room (auto-leaves current room first) |
| `leave_room` | — | Leave current room |
| `room_message` | `messageType`, `value` | Broadcast to all room members (including sender) |
| `direct_message` | `targetId`, `messageType`, `value` | Send to a specific client by ID |
| `find_match` | `gameId`, optional `side` | Queue for matchmaking; if `side` is present and valid, only the opposite side for that game can match |
| `queue_status` | `gameId` | Start watching a game's queue counts and receive the current totals immediately |
| `cancel_match` | — | Leave matchmaking queue |
| `ping` | — | Keepalive |

### Server → Client (event names)

| event | fields | when |
|---|---|---|
| `connected` | `clientId` | On WS connect |
| `room_joined` | `roomCode`, `playerCount`, `created?` | After joining/creating a room |
| `room_left` | `roomCode` | After leaving a room |
| `player_joined` | `clientId`, `roomCode`, `playerCount` | Sent to existing room members when someone joins |
| `player_left` | `clientId`, `roomCode`, `playerCount`, `reason` | Sent to remaining members |
| `match_ready` | `seed`, `serverNow`, `startAt`, `remoteSide`, `roomCode` | Sent to both room members when the server is ready to start a synchronized countdown |
| `message` | `scope` (`room`/`direct`), `messageType`, `value`, `senderId`, `roomCode?` | Game message relay |
| `queue_status` | `gameId`, `queueCounts`, `boyWaiting`, `girlWaiting` | Current per-side queue counts for a watched game; also pushed when those counts change |
| `searching` | — | Entered matchmaking queue |
| `search_cancelled` | — | Left matchmaking queue |
| `pong` | — | Response to ping |
| `error` | `code`, `message` | Error codes: `BAD_JSON`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `SIDE_CONFLICT`, `NOT_IN_ROOM`, `CLIENT_NOT_FOUND`, `UNKNOWN_TYPE` |

## HTTP Routes

- `GET /` — plain text status
- `GET /health` — JSON: `{ ok, service, clients, rooms, queues, maxPlayersPerRoom }`

## Key Helpers

- `send(ws, payload)` / `sendToClient(clientId, payload)` — safe JSON send (`src/transport.mjs`)
- `broadcastToRoom(roomCode, payload, exceptClientId?)` — broadcast, optionally skipping one client (`src/rooms.mjs`)
- `leaveRoom(clientId, reason)` — removes from room, fires `player_left` to remaining, `room_left` to leaver; deletes room if empty (`src/rooms.mjs`)
- `joinRoom(clientId, roomCode)` — validates, handles already-in-room, fires `room_joined` + `player_joined` (`src/rooms.mjs`)
- `leaveQueue(clientId)` — removes from whichever match queue the client is in (`src/matchmaking.mjs`)
- Side-aware matchmaking is opt-in. Older games that only send `gameId` still use the legacy per-game queue.
- `buildMatchReadyMessages(...)` — builds the mirrored `match_ready` payloads that share one seed and one countdown start time (`src/matchmaking.mjs`)
- Adding a new lobby-based game: implement the lobby game-module interface (see `src/lobby.mjs`) in a `games/<game>/server/*-lobby-game.mjs` and register it in `games/registry.mjs` — do **not** add game branches to `src/lobby.mjs`.
- Current handoff note: the countdown/start ownership pass is done; future work for strict-timing games should focus on richer replicated state or server assistance, not on reworking matchmaking again

## Tests

`npm test` runs the colocated `.test.mjs` suites: `src/matchmaking.test.mjs`, `src/lobby.test.mjs`, `games/echo-duel/echo-duel.test.mjs`, `games/build-buddy/build-buddy.test.mjs`, and the three `games/circuit-siege/*.test.mjs` suites. Pure match engines and helpers are unit tested directly (no socket needed); each test file is self-contained and exits non-zero on failure.

Queue status note: `queue_status` watchers now receive immediate and change-driven updates with `queueCounts`, `boyWaiting`, and `girlWaiting` for the requested game.

## Test Client

`test.html` — browser UI that connects to `ws://localhost:3000`. Buttons for connect, create room, join room, and send a room message. Open directly in browser (no build step).
