// The socket-facing half of Speed Demon online.
//
// A self-owning bridge, following circuit-siege: it manages its own rooms,
// its own queue and its own match state, and intercepts the client messages
// that belong to it rather than going through the generic room code. Every rule
// lives in `speed-demon-match-engine.mjs`; this file is the wiring between that
// engine and the wire.
//
// ## The two ways in
//
//   **Quick search** — `find_match`. Symmetric: a drag race has no asymmetric
//   roles, so there is one queue and whoever is waiting races whoever turns up.
//   The race config comes from the match seed, so neither client configures it
//   and neither has to negotiate.
//
//   **Private room** — `create_room` returns a code; `join_room` takes one. Here
//   the host owns the config and the guest watches it change live.
//
// ## The round loop
//
//   both ready  ->  sd_round_start (one startAt for both trees)
//               ->  clients race, streaming inputs as they go
//               ->  both report done, or the round times out
//               ->  server replays both logs and decides
//               ->  sd_round_result, then back to ready-up, or the match ends
//
// The client never reports a time. It reports *inputs*, and the server replays
// them. See the match engine for why that is the whole point.

import {
  createSpeedDemonMatchEngine,
  configFromSeed,
  normalizeConfig,
} from "./speed-demon-match-engine.mjs";
import { createSpeedDemonRoomStore } from "./speed-demon-room-store.mjs";

export const SPEED_DEMON_GAME_ID = "speed-demon";

export function createSpeedDemonServerBridge({
  now = () => Date.now(),
  createRoomCode = () => Math.random().toString(36).slice(2, 7).toUpperCase(),
  sendToClient,
  makeSeed = () => Math.floor(Math.random() * 2 ** 31),
} = {}) {
  const store = createSpeedDemonRoomStore();

  const emit = (clientId, payload) => sendToClient(clientId, payload);

  function emitToRoom(room, payload) {
    for (const clientId of room.memberClientIds) emit(clientId, payload);
  }

  function emitQueueStatus(clientId) {
    emit(clientId, { event: "queue_status", gameId: SPEED_DEMON_GAME_ID, ...store.getQueueCounts() });
  }

  /** The room as both clients should see it: who is in it, and what is being raced. */
  function emitLobby(room) {
    const described = room.engine.describe();
    for (const clientId of room.memberClientIds) {
      emit(clientId, {
        event: "sd_lobby",
        roomCode: room.roomCode,
        private: room.isPrivate,
        // Sent per client so each knows which car is theirs and whether the
        // config controls should be live for them.
        youAreHost: clientId === described.hostClientId,
        yourPlayerId: room.engine.playerFor(clientId)?.playerId ?? null,
        ...described,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------

  function newRoom({ isPrivate, config }) {
    const roomCode = createRoomCode();
    const room = {
      roomCode,
      isPrivate,
      seed: makeSeed(),
      engine: createSpeedDemonMatchEngine({ now, config }),
      memberClientIds: new Set(),
    };
    return store.createRoom(roomCode, room);
  }

  function addToRoom(room, payload, created = false) {
    const assigned = room.engine.assignPlayer(payload);
    if (!assigned.ok) {
      emit(payload.clientId, { event: "error", code: assigned.code, message: assigned.message });
      return false;
    }
    room.memberClientIds.add(payload.clientId);
    store.assignClientToRoom(payload.clientId, room.roomCode);

    emit(payload.clientId, {
      event: "room_joined",
      roomCode: room.roomCode,
      created,
      playerCount: room.memberClientIds.size,
    });
    if (room.memberClientIds.size > 1) {
      emitToRoom(room, {
        event: "player_joined",
        roomCode: room.roomCode,
        playerCount: room.memberClientIds.size,
      });
    }
    emitLobby(room);
    return true;
  }

  function playerPayload(clientId, data) {
    return {
      clientId,
      playerId: typeof data?.playerId === "string" ? data.playerId : "",
      displayName: typeof data?.displayName === "string" ? data.displayName : "",
      modelId: typeof data?.modelId === "string" ? data.modelId : null,
      livery: data?.livery ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Entry points
  // -------------------------------------------------------------------------

  function handleFindMatch(clientId, data) {
    leaveCurrentRoom(clientId, "searching");
    const opponent = store.takeQueuedOpponent();

    if (!opponent) {
      store.enqueue({ clientId, data });
      emit(clientId, { event: "searching", gameId: SPEED_DEMON_GAME_ID });
      broadcastQueueStatus();
      return;
    }

    // Paired. The config comes from the seed so that neither driver picked it.
    const room = newRoom({ isPrivate: false, config: {} });
    room.engine.setConfig(opponent.clientId, configFromSeed(room.seed));
    addToRoom(room, playerPayload(opponent.clientId, opponent.data), true);
    addToRoom(room, playerPayload(clientId, data));
    broadcastQueueStatus();
  }

  function handleCreateRoom(clientId, data) {
    leaveCurrentRoom(clientId, "left");
    store.removeQueuedClient(clientId);
    const room = newRoom({ isPrivate: true, config: normalizeConfig(data?.config ?? {}) });
    addToRoom(room, playerPayload(clientId, data), true);
  }

  function handleJoinRoom(clientId, data) {
    const roomCode = String(data?.roomCode || "").trim().toUpperCase();
    const room = store.getRoom(roomCode);
    if (!room) {
      emit(clientId, { event: "error", code: "ROOM_NOT_FOUND", message: "No room with that code" });
      return;
    }
    leaveCurrentRoom(clientId, "left");
    store.removeQueuedClient(clientId);
    addToRoom(room, playerPayload(clientId, data));
  }

  function handleCancelMatch(clientId) {
    store.removeQueuedClient(clientId);
    emit(clientId, { event: "search_cancelled" });
    broadcastQueueStatus();
  }

  // -------------------------------------------------------------------------
  // In-room messages
  // -------------------------------------------------------------------------

  function handleRoomMessage(clientId, data) {
    const room = store.getRoomForClient(clientId);
    if (!room) return;
    const type = String(data?.messageType || "");
    const value = parseValue(data?.value);

    switch (type) {
      case "loadout":
        room.engine.setLoadout(clientId, value ?? {});
        emitLobby(room);
        return;

      case "config": {
        const result = room.engine.setConfig(clientId, value ?? {});
        if (!result.ok) {
          emit(clientId, { event: "error", code: result.code, message: result.message });
          return;
        }
        emitLobby(room);
        return;
      }

      case "ready":
        if (value?.ready !== false) {
          const issue = room.engine.circuitStartIssue();
          if (issue) {
            emit(clientId, { event: "error", code: issue.code, message: issue.message });
            return;
          }
        }
        room.engine.setReady(clientId, value?.ready !== false);
        emitLobby(room);
        if (room.engine.everyoneReady()) startRound(room);
        return;

      // The live input stream. Relayed to the opponent so their client can draw
      // this car, and folded into the log the server will adjudicate on.
      case "inputs": {
        const circuit = room.engine.config.raceTypeId === "circuit";
        const accepted = (circuit ? room.engine.recordCircuitInputs : room.engine.recordInputs)(clientId, {
          round: Number(value?.round),
          attempt: Number(value?.attempt),
          events: Array.isArray(value?.events) ? value.events : [],
        });
        if (!accepted || accepted.accepted.length === 0 || circuit) return;
        for (const memberId of room.memberClientIds) {
          if (memberId === clientId) continue;
          emit(memberId, {
            event: "sd_inputs",
            playerId: accepted.player.playerId,
            round: Number(value.round),
            attempt: Number(value.attempt),
            events: accepted.accepted,
          });
        }
        return;
      }

      // "I have sent you everything." Deliberately carries no result: what this
      // client thinks it achieved is not evidence of anything.
      case "done":
        room.engine.recordDone(clientId, {
          round: Number(value?.round),
          attempt: Number(value?.attempt),
        });
        if (room.engine.roundIsOver()) finishRound(room);
        return;

      case "rematch": {
        const result = room.engine.requestRematch(clientId);
        if (!result.ok) return;
        emitToRoom(room, { event: "sd_rematch", requested: result.requested, started: result.started });
        if (result.started) emitLobby(room);
        return;
      }

      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // The round loop
  // -------------------------------------------------------------------------

  function startRound(room) {
    const start = room.engine.startRound();
    if (!start) return;
    emitToRoom(room, { event: "sd_round_start", roomCode: room.roomCode, seed: room.seed, ...start });
  }

  function finishRound(room) {
    const result = room.engine.adjudicate();
    if (!result) return;
    emitToRoom(room, { event: "sd_round_result", roomCode: room.roomCode, ...result });
  }

  /**
   * The heartbeat, called by the registry. Its one job is the round that never
   * reported in: a driver who closed the tab mid-run would otherwise leave the
   * other one staring at a tree that never resolves.
   */
  function tickActiveRooms() {
    // Same containment: this runs on a shared interval, so a throw here would
    // take down every game on the server, not only Speed Demon.
    try {
      sweepRooms();
    } catch (error) {
      console.error("[speed-demon] heartbeat:", error);
    }
  }

  function sweepRooms() {
    for (const room of store.listRooms()) {
      // A round is only live between the tree and both drivers reporting in, so
      // those are the two phases where a timeout means anything.
      const live = room.engine.phase === "running" || room.engine.phase === "countdown";
      if (live && room.engine.config.raceTypeId === "circuit") {
        const advanced = room.engine.advanceCircuit();
        if (!advanced) continue;
        emitToRoom(room, {
          event: "sd_circuit_snapshot",
          roomCode: room.roomCode,
          round: room.engine.describe().round?.number ?? 0,
          attempt: room.engine.describe().round?.attempt ?? 1,
          serverNow: now(),
          ...advanced.snapshot,
        });
        if (advanced.result) {
          emitToRoom(room, { event: "sd_round_result", roomCode: room.roomCode, ...advanced.result });
        }
        continue;
      }
      if (live && room.engine.roundIsOver()) finishRound(room);
    }
  }

  // -------------------------------------------------------------------------
  // Leaving
  // -------------------------------------------------------------------------

  function leaveCurrentRoom(clientId, reason = "left") {
    const room = store.getRoomForClient(clientId);
    if (!room) return;

    const left = room.engine.removePlayer(clientId);
    room.memberClientIds.delete(clientId);
    store.removeClientFromRoom(clientId);
    emit(clientId, { event: "room_left", roomCode: room.roomCode });

    if (room.memberClientIds.size === 0) {
      store.deleteRoom(room.roomCode);
      return;
    }
    emitToRoom(room, {
      event: "player_left",
      roomCode: room.roomCode,
      clientId,
      playerCount: room.memberClientIds.size,
      reason,
    });
    // A match in progress is conceded rather than left hanging.
    if (left?.conceded) {
      emitToRoom(room, {
        event: "sd_match_forfeit",
        roomCode: room.roomCode,
        winnerId: left.winnerId,
        loserId: left.player.playerId,
        reason: "disconnect",
      });
    }
    emitLobby(room);
  }

  function handleLeaveRoom(clientId) {
    leaveCurrentRoom(clientId, "left");
  }

  function handleClientDisconnect(clientId) {
    store.removeQueuedClient(clientId);
    leaveCurrentRoom(clientId, "disconnected");
    broadcastQueueStatus();
  }

  /**
   * Only the drivers actually waiting are told how many are waiting. A client
   * already in a room has a lobby on screen and no use for a queue count.
   */
  function broadcastQueueStatus() {
    for (const clientId of store.listQueuedClientIds()) emitQueueStatus(clientId);
  }

  // -------------------------------------------------------------------------
  // Router surface
  // -------------------------------------------------------------------------

  function ownsClient(clientId) {
    return store.isQueuedClient(clientId) || store.getRoomForClient(clientId) !== null;
  }

  function hasRoomCode(roomCode) {
    return store.hasRoomCode(roomCode);
  }

  /**
   * The name matters: `src/router.mjs` calls `bridge.handleClientMessage`, and a
   * bridge that exposes anything else throws on the first frame and takes the
   * whole server process down with it. Same for `handleClientDisconnect`.
   */
  function handleClientMessage(clientId, data) {
    // `src/router.mjs` calls this straight out of a `ws` message handler with no
    // guard of its own, so anything that escapes here is an unhandled exception
    // in an event emitter — which ends the Node process and every other match
    // running on it. One room's bug must cost that room, not the server.
    try {
      return route(clientId, data);
    } catch (error) {
      emit(clientId, {
        event: "error",
        code: "INTERNAL",
        message: "Something went wrong in that match",
      });
      console.error(`[speed-demon] ${data?.type ?? "message"} from ${clientId}:`, error);
      return undefined;
    }
  }

  function route(clientId, data) {
    const type = String(data?.type || "");
    switch (type) {
      case "find_match":
        return handleFindMatch(clientId, data);
      case "create_room":
        return handleCreateRoom(clientId, data);
      case "join_room":
        return handleJoinRoom(clientId, data);
      case "cancel_match":
        return handleCancelMatch(clientId);
      case "leave_room":
        return handleLeaveRoom(clientId);
      case "room_message":
        return handleRoomMessage(clientId, data);
      case "queue_status":
        return emitQueueStatus(clientId);
      default:
        return undefined;
    }
  }

  return {
    // These four names are the router's contract — see handleClientMessage.
    handleClientMessage,
    handleClientDisconnect,
    tickActiveRooms,
    ownsClient,
    hasRoomCode,
    // Exposed for tests, which drive rooms directly rather than through sockets.
    getRoomForClient: (clientId) => store.getRoomForClient(clientId),
    getRoom: (roomCode) => store.getRoom(roomCode),
  };
}

/** Room messages carry their value as JSON or as an object, depending on caller. */
function parseValue(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
