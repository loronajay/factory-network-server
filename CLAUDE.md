# factory-network-server

Real-time WebSocket multiplayer backend for **JayArcade** games. Handles rooms, matchmaking, and message relay. Single-file Node.js server (`server.js`).

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
- **Node.js** + **Express 5** + **ws** (WebSocket library)
- No database — all state is in-memory, intentionally ephemeral
- Entry point: `server.js`
- Start: `npm start`

## In-Memory State

| Variable | Type | Purpose |
|---|---|---|
| `clients` | `Map<clientId, ws>` | All connected WebSocket clients |
| `clientRooms` | `Map<clientId, roomCode>` | Which room each client is in |
| `rooms` | `Map<roomCode, Set<clientId>>` | Members of each room |
| `matchQueues` | `Map<gameId, clientId[]>` | Per-game matchmaking queues |

- `MAX_PLAYERS_PER_ROOM = 2`
- `clientId` format: `c_<8 hex chars>` (e.g. `c_1a2b3c4d`)
- Room codes: 5 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no ambiguous chars)

## WebSocket Protocol

### Client → Server (message `type`)

| type | fields | behavior |
|---|---|---|
| `create_room` | — | Leaves current room if any, creates new room, joins it |
| `join_room` | `roomCode` | Join existing room (auto-leaves current room first) |
| `leave_room` | — | Leave current room |
| `room_message` | `messageType`, `value` | Broadcast to all room members (including sender) |
| `direct_message` | `targetId`, `messageType`, `value` | Send to a specific client by ID |
| `find_match` | `gameId` | Queue for matchmaking; if opponent waiting, both get a room |
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
| `message` | `scope` (`room`/`direct`), `messageType`, `value`, `senderId`, `roomCode?` | Game message relay |
| `searching` | — | Entered matchmaking queue |
| `search_cancelled` | — | Left matchmaking queue |
| `pong` | — | Response to ping |
| `error` | `code`, `message` | Error codes: `BAD_JSON`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `NOT_IN_ROOM`, `CLIENT_NOT_FOUND`, `UNKNOWN_TYPE` |

## HTTP Routes

- `GET /` — plain text status
- `GET /health` — JSON: `{ ok, service, clients, rooms, queues, maxPlayersPerRoom }`

## Key Helpers

- `send(ws, payload)` — safe JSON send (checks `readyState`)
- `sendToClient(clientId, payload)` — send via clientId lookup
- `broadcastToRoom(roomCode, payload, exceptClientId?)` — broadcast, optionally skipping one client
- `leaveRoom(clientId, reason)` — removes from room, fires `player_left` to remaining, `room_left` to leaver; deletes room if empty
- `joinRoom(clientId, roomCode)` — validates, handles already-in-room, fires `room_joined` + `player_joined`
- `leaveQueue(clientId)` — removes from whichever match queue the client is in

## Test Client

`test.html` — browser UI that connects to `ws://localhost:3000`. Buttons for connect, create room, join room, and send a room message. Open directly in browser (no build step).
