# factory-network-server

WebSocket matchmaking server powering real-time multiplayer for
[TurboWarp](https://turbowarp.org) games via the `factory-network.js` extension
in the [TurboWarp Game Factory](https://github.com/loronajay/textify-blockify-IR).

Part of the [Jay Arcade](https://github.com/loronajay/loronajay) ecosystem.

## What it does

- Assigns each connecting player a unique persistent ID (`c_` + random hex)
- Room-based grouping (max 2 players) with auto-generated 5-character room codes
- Automatic 1v1 matchmaking queue — per game ID by default, with optional side-aware pairing for games that send a side/role
- Room broadcast and direct peer-to-peer messaging
- Player join/leave/disconnect lifecycle events broadcast to room members
- Server-owned countdown / match start payloads for games that use `match_ready`
- Live watched queue-count updates for games that request `queue_status`
- `/health` endpoint showing live client count, room count, and per-game queue depth

## Message types

`queue_status` lets a client watch one game's live per-side queue totals and receive updates whenever those counts change.

| Type | Direction | Description |
|---|---|---|
| `create_room` | client → server | Create a new room, optionally carrying a chosen side/role |
| `join_room` | client → server | Join an existing room by code, optionally carrying a chosen side/role |
| `leave_room` | client → server | Exit current room |
| `find_match` | client → server | Enter matchmaking queue for a game; optional `side` enables opposite-side pairing |
| `cancel_match` | client → server | Exit matchmaking queue |
| `room_message` | client → server | Broadcast a message to all room members |
| `direct_message` | client → server | Send a message to a specific client ID |
| `ping` | client → server | Heartbeat — server responds with `pong` |

## Events (server → client)

| Event | Description |
|---|---|
| `connected` | Sent on connect — includes the client's assigned ID |
| `room_joined` | Confirmed entry into a room |
| `room_left` | Confirmed exit from a room |
| `player_joined` | Another player entered the room |
| `player_left` | Another player left or disconnected |
| `match_ready` | Server-owned seed + countdown timing, plus game-specific `matchSettings` when required |
| `message` | Incoming room broadcast or direct message |
| `searching` | Entered matchmaking queue, waiting for opponent |
| `search_cancelled` | Left matchmaking queue |
| `error` | Something went wrong — includes a code and message |

## Side-Aware Matchmaking

`find_match` accepts:

```json
{ "type": "find_match", "gameId": "lovers-lost", "side": "boy" }
```

or:

```json
{ "type": "find_match", "gameId": "lovers-lost", "side": "girl" }
```

When a valid `side` is included, the server queues that player into a `gameId:side` bucket and only matches them with the opposite side for the same game. If `side` is omitted, the legacy per-game queue behavior is preserved for older clients.

Private rooms may also carry `side` and `gameId` on `create_room` / `join_room`. If a joining player requests a side already occupied in that room, the server returns `SIDE_CONFLICT`.

Sumorai receives server-authored `matchSettings` in `match_ready`, including `roundTarget`, `rulesVersion`, and a full `stagePlan` so both players use the exact same layouts.

Games may also send `queue_status` with a `gameId` to receive immediate and change-driven queue totals for that game's watched side buckets. This is what `Lovers Lost` now uses to render the live `boys in the yard` / `girls in the yard` lobby copy.

## Stack

Node.js · Express · WebSockets (`ws`)

## How it connects

`factory-network.js` is a TurboWarp extension that wraps this server's full protocol
into Scratch blocks. Game developers call `connect`, `find a match`, and `send message`
— the extension handles everything else.

See [`FACTORY_NETWORK.md`](https://github.com/loronajay/textify-blockify-IR/blob/main/factory_extensions/FACTORY_NETWORK.md)
for the full extension documentation.

## Running locally

```bash
npm install
npm start   # node server.mjs
```

Runs on port 3000 by default. Set `PORT` env var to override.
