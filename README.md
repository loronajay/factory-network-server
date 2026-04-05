# factory-network-server

WebSocket matchmaking server powering real-time multiplayer for
[TurboWarp](https://turbowarp.org) games via the `factory-network.js` extension
in the [TurboWarp Game Factory](https://github.com/loronajay/textify-blockify-IR).

Part of the [Jay Arcade](https://github.com/loronajay/loronajay) ecosystem.

## What it does

- Assigns each connecting player a unique persistent ID (`c_` + random hex)
- Room-based grouping (max 2 players) with auto-generated 5-character room codes
- Automatic 1v1 matchmaking queue — per game ID, first two waiting players are paired
- Room broadcast and direct peer-to-peer messaging
- Player join/leave/disconnect lifecycle events broadcast to room members
- `/health` endpoint showing live client count, room count, and per-game queue depth

## Message types

| Type | Direction | Description |
|---|---|---|
| `create_room` | client → server | Create a new room, get a room code back |
| `join_room` | client → server | Join an existing room by code |
| `leave_room` | client → server | Exit current room |
| `find_match` | client → server | Enter matchmaking queue for a game |
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
| `message` | Incoming room broadcast or direct message |
| `searching` | Entered matchmaking queue, waiting for opponent |
| `search_cancelled` | Left matchmaking queue |
| `error` | Something went wrong — includes a code and message |

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
node server.js
```

Runs on port 3000 by default. Set `PORT` env var to override.
