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
| `src/matchmaking.mjs` | Queues, side strategies, `match_ready`, `queue_status` |
| `src/rooms.mjs` | 1v1 room lifecycle (join/leave/broadcast) |
| `src/lobby-bus.mjs` | Lobby messaging primitives (leaf: broadcast/payload) |
| `src/lobby.mjs` | Generic v2 lobby lifecycle (game-agnostic) |
| `src/router.mjs` | WebSocket message dispatch table |
| `games/registry.mjs` | The single index of game definitions |
| `games/<id>/server/<id>.game.mjs` | One uniform **Game Definition** per game |

### One model: Game Definitions

**Generic code (everything in `src/`) never names a specific game.** It asks the
registry. Each game is described by a uniform definition at
`games/<id>/server/<id>.game.mjs`:

```js
export const definition = {
  id,            // exact gameId  (or)
  matches,       // (gameId) => boolean — for families/variants (prefixes, -ranked)
  matchmaking,   // { strategy: "side-pair" | "symmetric-balanced" | "lobby" | "self-owned", sides? }
  matchSettings, // optional (seed) => deterministic server config object | null
  lobbyGame,     // optional — lobby game-module (lobby-based games)
  bridge,        // optional — { create(ctx), shouldRoute(clientId, data, instance) }
};
```

The registry exposes `lobbyGame(gameId)`, `matchmakingStrategy(gameId)`,
`matchSettings(gameId, seed)`, and the bridge manager (`routeToBridge`,
`bridgeOwningClient`, `startBridgeHeartbeats`). **An unregistered gameId falls back
to plain relay + the default `side-pair` strategy** — that's how the many
relay-only games (lovers-lost, battleshits, …) work with zero server code.

A game's *folder* holds whatever its definition needs: lobby-based games
(`echo-duel`, `build-buddy`) have a pure `*-match-engine.mjs` + a `*-lobby-game.mjs`
adapter; the self-owning `circuit-siege` and `speed-demon` have bridges;
`sumorai` has only a seeded stage-plan; `creature-battler` / `cockpit-swarm` are just a strategy
descriptor. `speed-demon` is the **server-authoritative** one: its bridge owns the queue,
the room codes, the christmas tree and the match, and it decides every round by
*replaying both drivers' input logs* through a mirrored copy of the cabinet's
pure physics under `games/speed-demon/shared/`. Clients send inputs and never a
finishing time — see that folder's notes. `mini-hoops` is a **server-authoritative lobby game** and its folder now holds **two**
definitions off one mirrored sim: `mini-hoops` (the timed score duel — the server owns the
deadline and replays every pull) and `mini-hoops-horse` (HORSE — no clock at all; a match
ends when a player spells the word). HORSE adds one shape the others do not have: a
**placement is authoritative mid-match state**, submitted by the setter, re-clamped through
the cabinet's own legal-volume function, and replicated so the opponent draws the same bin.
Both refuse any client-authored outcome with `SERVER_AUTHORITY`. `mini-tactics` is a **config-only lobby game** (2-4 players, FFA +
2v2 teams): its `lobbyGame` carries `lobbyLimits` only — no match engine — because
the match runs as deterministic client lockstep over the generic lobby relay
(shared `seed` + ordered `members` from `lobby_started`; board size/format/squads
exchanged in-band via `config`/`setup` lobby_messages; owner broadcasts the
state-hash; a dropped seat is conceded by the remaining owner).

### Adding a game (the one path)

1. Create `games/<id>/server/<id>.game.mjs` exporting a `definition`.
2. Register it in the `import`s + `allDefinitions()` array in `games/registry.mjs`.
3. Add a `.test.mjs` for any logic; if there's none, `games/registry.test.mjs`
   already covers strategy/settings resolution.

**A bridge must export exactly `handleClientMessage`, `handleClientDisconnect`,
`tickActiveRooms`, `ownsClient` and `hasRoomCode`.** `src/router.mjs` calls them
unguarded, so a bridge naming one of them differently throws on the first frame
it is handed — inside a `ws` message handler, which ends the whole process.
`games/speed-demon/server-bridge.test.mjs` scrapes the router for every
`bridge.*()` call and asserts the bridge answers all of them; copy that test when
adding a bridge.

**Wrap a bridge's own work in try/catch too.** Anything escaping
`handleClientMessage` or `tickActiveRooms` takes down every match on the server,
not just the one that went wrong.

Do **not** add a gameId branch to anything in `src/`. The
`src/no-game-literals.test.mjs` guardrail fails the build if a gameId literal
appears in generic code — that's intentional, to stop special-cases from creeping
back in across edits.

### Import cycles

`rooms ↔ lobby` and `lobby → registry` reference each other only inside function
bodies (safe under ESM). Game adapters import the **leaf** `src/lobby-bus.mjs`
(not `src/lobby.mjs`) so the registry is *not* part of an import cycle; the
registry's definition list is still built lazily as cheap insurance.

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
- `buildMatchReadyMessages(...)` — builds the mirrored `match_ready` payloads that share one seed and one countdown start time; takes the game's server-owned `matchSettings` object (or null) as its last argument (`src/matchmaking.mjs`)
- Adding/changing a game: see **Adding a game** above. Generic `src/` code must stay game-agnostic (the `no-game-literals` guardrail enforces it).
- Current handoff note: the countdown/start ownership pass is done; future work for strict-timing games should focus on richer replicated state or server assistance, not on reworking matchmaking again

## Tests

`npm test` runs the colocated `.test.mjs` suites: `src/matchmaking.test.mjs`, `src/lobby.test.mjs`, `src/no-game-literals.test.mjs` (the game-agnostic guardrail), `games/registry.test.mjs` (strategy/settings/lobby resolution), `games/echo-duel/echo-duel.test.mjs`, `games/build-buddy/build-buddy.test.mjs`,
`games/mini-hoops/mini-hoops.test.mjs` + `games/mini-hoops/mini-hoops-horse.test.mjs`, the three `games/circuit-siege/*.test.mjs` suites, and the three `games/speed-demon/*.test.mjs` suites (replay/mirror guard, match engine, server bridge).

**`games/speed-demon/replay.test.mjs` is a mirror guard, not a unit test.** Its
`shared/` folder is a *copy* of the cabinet's pure sim, and the failure mode of
any mirror is silent drift — the physics get retuned over there, this server
keeps adjudicating on the old ones, and it hands rounds to the wrong car while
every suite stays green. Both repos commit the same `golden-run.json` and both
replay it to the same decimal. If it fails, re-run
`node tools/mirror-sim.mjs` in `javascript-games/games/speed-demon` and copy the
result across. Pure match engines and helpers are unit tested directly (no socket needed); each test file is self-contained and exits non-zero on failure.

Queue status note: `queue_status` watchers now receive immediate and change-driven updates with `queueCounts`, `boyWaiting`, and `girlWaiting` for the requested game.

## Test Client

`test.html` — browser UI that connects to `ws://localhost:3000`. Buttons for connect, create room, join room, and send a room message. Open directly in browser (no build step).
