// Speed Demon game definition.
//
// A self-owning bridge: the game manages its own rooms, queue and match state,
// and intercepts the client messages that belong to it rather than going through
// the generic room/lobby code. That is the circuit-siege shape, and Speed Demon
// needs it for one reason — **the server decides who won**.
//
// A drag race is two cars in two lanes that never touch, so each client
// simulates its own car with no input delay at all (lockstep would tax the exact
// millisecond shift timing the game is about, and buy nothing, because there is
// nothing to keep consistent between them). What the clients exchange is inputs.
// The server keeps both input logs and replays them through its own copy of the
// physics under `../shared/` — so a client can claim inputs, but the server
// decides what those inputs achieved, including whether the driver red-lighted.
//
// `matchSettings` is deliberately absent: the generic matchmaker never builds a
// Speed Demon room, the bridge does, and the race config comes from the room's
// own seed. Leaving it out keeps one source of truth for what is being raced.

import { createSpeedDemonServerBridge } from "./speed-demon-server-bridge.mjs";

const GAME_ID = "speed-demon";

export const definition = {
  id: GAME_ID,
  // Listed for completeness and for anything that asks the registry directly.
  // The bridge owns pairing, so the generic matchmaker never runs for this id.
  matchmaking: { strategy: "self-owned" },
  bridge: {
    // Instantiated lazily by the registry, which supplies a collision-free
    // createRoomCode (checking rooms, lobbies and every other bridge),
    // sendToClient, and a clock.
    create({ createRoomCode, sendToClient, now }) {
      return createSpeedDemonServerBridge({ createRoomCode, sendToClient, now });
    },

    // Does this message belong to a Speed Demon session?
    shouldRoute(clientId, data, bridge) {
      const type = String(data?.type || "");
      const gameId = String(data?.gameId || "");

      if (type === "find_match" || type === "queue_status" || type === "create_room") {
        return gameId === GAME_ID;
      }
      // A join may name the game, or just quote a code this bridge handed out —
      // which is what makes a private room code shareable on its own.
      if (type === "join_room") {
        if (gameId === GAME_ID) return true;
        const roomCode = String(data?.roomCode || "").trim().toUpperCase();
        return roomCode ? bridge.hasRoomCode(roomCode) : false;
      }
      if (type === "cancel_match" || type === "room_message" || type === "leave_room") {
        return bridge.ownsClient(clientId);
      }
      return false;
    },
  },
};
