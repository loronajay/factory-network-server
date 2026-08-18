import { parseCircuitActionIntent, parseProfileMessage } from "../shared/commands.mjs";
import { parseMatchSnapshotMessage, serializeMatchEvent, serializeMatchSnapshot } from "../shared/snapshots.mjs";
import { createCircuitSiegeRoomEngine } from "./circuit-siege-room-engine.mjs";
import { createCircuitSiegeRoomStore } from "./circuit-siege-room-store.mjs";

const CIRCUIT_SIEGE_GAME_ID = "circuit-siege";

function createRoomRecord({ roomCode, roomId, engine }) {
  return {
    roomCode,
    roomId,
    engine,
    memberClientIds: new Set()
  };
}

function toPlayerPayload(message) {
  return {
    clientId: message.clientId,
    playerId: typeof message.playerId === "string" ? message.playerId : "",
    displayName: typeof message.displayName === "string" ? message.displayName : "Player",
    side: message.side
  };
}

export function createCircuitSiegeServerBridge({
  selectBoard,
  now = () => Date.now(),
  createRoomCode = () => Math.random().toString(36).slice(2, 6).toUpperCase(),
  sendToClient
} = {}) {
  const store = createCircuitSiegeRoomStore();
  let roomIndex = 0;

  function emit(clientId, payload) {
    sendToClient(clientId, payload);
  }

  function emitQueueStatus(clientId) {
    emit(clientId, {
      event: "queue_status",
      gameId: CIRCUIT_SIEGE_GAME_ID,
      ...store.getQueueCounts()
    });
  }

  function emitToRoom(room, payload) {
    for (const clientId of room.memberClientIds) {
      emit(clientId, payload);
    }
  }

  function addPlayerToRoom(room, playerPayload, created = false) {
    const assigned = room.engine.assignPlayer(playerPayload);
    if (!assigned.ok) {
      return assigned;
    }

    room.memberClientIds.add(playerPayload.clientId);
    store.assignClientToRoom(playerPayload.clientId, room.roomCode);

    emit(playerPayload.clientId, {
      event: "room_joined",
      roomCode: room.roomCode,
      created
    });

    if (room.memberClientIds.size >= 2) {
      emitToRoom(room, {
        event: "player_joined",
        roomCode: room.roomCode,
        playerCount: room.memberClientIds.size
      });
      maybeStartRoom(room);
    }

    return assigned;
  }

  function createRoomWithPlayers(firstPlayer, secondPlayer = null) {
    const selectedBoard = typeof selectBoard === "function" ? selectBoard() : null;
    if (!selectedBoard?.board) {
      throw new Error("Circuit Siege bridge requires a board selector that returns a board.");
    }
    const roomCode = createRoomCode();
    const room = createRoomRecord({
      roomCode,
      roomId: `circuit-siege-room-${++roomIndex}`,
      engine: createCircuitSiegeRoomEngine({
        board: selectedBoard.board,
        boardId: selectedBoard.mapEntry?.mapId || selectedBoard.board?.mapId || null,
        roomId: `circuit-siege-room-${roomIndex}`,
        roomCode
      })
    });

    store.createRoom(roomCode, room);
    addPlayerToRoom(room, firstPlayer, true);

    if (secondPlayer) {
      addPlayerToRoom(room, secondPlayer, false);
    }

    return room;
  }

  function maybeStartRoom(room) {
    const result = room.engine.startMatch({ now: now() });
    if (!result.ok) return result;

    const snapshotValue = serializeMatchSnapshot(result.snapshot);
    for (const side of ["blue", "red"]) {
      const player = result.snapshot.players[side];
      if (!player) continue;
      emit(player.clientId, {
        event: "match_ready",
        mapId: result.snapshot.boardId,
        roomCode: room.roomCode,
        seed: 0,
        remoteSide: side === "blue" ? "red" : "blue",
        serverNow: now(),
        startAt: now()
      });
      emit(player.clientId, {
        event: "message",
        senderId: "server",
        roomCode: room.roomCode,
        messageType: "match_snapshot",
        value: snapshotValue
      });
    }

    return result;
  }

  function broadcastSnapshot(room, snapshot) {
    const value = serializeMatchSnapshot(snapshot);
    emitToRoom(room, {
      event: "message",
      senderId: "server",
      roomCode: room.roomCode,
      messageType: "match_snapshot",
      value
    });
  }

  function broadcastMatchEvent(room, event) {
    emitToRoom(room, {
      event: "message",
      senderId: "server",
      roomCode: room.roomCode,
      messageType: "match_event",
      value: serializeMatchEvent(event)
    });
  }

  function relayRoomMessage(room, senderId, messageType, value) {
    emitToRoom(room, {
      event: "message",
      senderId,
      roomCode: room.roomCode,
      messageType,
      value
    });
  }

  function handleFindMatch(clientId, message) {
    leaveCurrentRoom(clientId, "find_match", false);
    store.removeQueuedClient(clientId);
    const playerPayload = toPlayerPayload({ ...message, clientId });
    const opponent = store.takeQueuedOpponent(message.side);

    if (!opponent) {
      store.enqueue(playerPayload);
      emit(clientId, { event: "searching" });
      emitQueueStatus(clientId);
      return;
    }

    const room = createRoomWithPlayers(opponent, playerPayload);
    emitQueueStatus(opponent.clientId);
    emitQueueStatus(playerPayload.clientId);
    return room;
  }

  function handleCreateRoom(clientId, message) {
    store.removeQueuedClient(clientId);
    leaveCurrentRoom(clientId, "create_room", false);
    const playerPayload = toPlayerPayload({ ...message, clientId });
    createRoomWithPlayers(playerPayload);
  }

  function handleJoinRoom(clientId, message) {
    store.removeQueuedClient(clientId);
    leaveCurrentRoom(clientId, "join_room", false);
    const room = store.getRoom(String(message.roomCode || "").trim().toUpperCase());
    if (!room) {
      emit(clientId, { event: "error", code: "ROOM_NOT_FOUND", message: "Room not found." });
      return;
    }

    const assigned = addPlayerToRoom(room, toPlayerPayload({ ...message, clientId }), false);
    if (!assigned.ok) {
      const code = assigned.errorCode === "SIDE_TAKEN" ? "SIDE_CONFLICT" : assigned.errorCode;
      emit(clientId, { event: "error", code, message: "Unable to join room." });
    }
  }

  function handleRoomMessage(clientId, message) {
    const room = store.getRoomForClient(clientId);
    if (!room) return;

    if (message.messageType === "profile") {
      const profile = parseProfileMessage(message.value);
      if (profile) {
        relayRoomMessage(room, clientId, "profile", message.value);
      }
      return;
    }

    if (message.messageType === "player_ready" || message.messageType === "request_start") {
      return;
    }

    if (message.messageType === "circuit_intent") {
      const intent = parseCircuitActionIntent(message.value);
      if (!intent) return;
      const applied = room.engine.applyIntent({
        clientId,
        intent,
        receivedAt: now()
      });

      if (!applied.ok) {
        emit(clientId, { event: "error", code: applied.errorCode, message: "Intent rejected." });
        return;
      }

      broadcastSnapshot(room, applied.snapshot);
      if (applied.resolvedRoute) {
        broadcastMatchEvent(room, {
          eventType: "route_resolved",
          ...applied.resolvedRoute
        });
      }
      return;
    }

    if (message.messageType === "match_snapshot") {
      const snapshot = parseMatchSnapshotMessage(message.value);
      if (snapshot) {
        relayRoomMessage(room, clientId, "match_snapshot", message.value);
      }
      return;
    }

    relayRoomMessage(room, clientId, message.messageType, message.value);
  }

  function leaveCurrentRoom(clientId, reason = "left", notifySelf = true) {
    const room = store.getRoomForClient(clientId);
    if (!room) return false;

    const result = room.engine.handleDisconnect(clientId);
    store.removeClientFromRoom(clientId);
    room.memberClientIds.delete(clientId);

    if (notifySelf) {
      emit(clientId, {
        event: "room_left",
        roomCode: room.roomCode
      });
    }

    if (room.memberClientIds.size > 0) {
      emitToRoom(room, {
        event: "player_left",
        clientId,
        roomCode: room.roomCode,
        playerCount: room.memberClientIds.size,
        reason
      });
    }

    if (result.ok) {
      broadcastSnapshot(room, result.snapshot);
    }

    if (!result.ok || result.snapshot.phase === "ended" || room.memberClientIds.size === 0) {
      store.deleteRoom(room.roomCode);
    }

    return true;
  }

  function handleCancelMatch(clientId) {
    const wasQueued = store.isQueuedClient(clientId);
    store.removeQueuedClient(clientId);
    if (wasQueued) {
      emitQueueStatus(clientId);
    }
    emit(clientId, { event: "search_cancelled" });
  }

  function routeClientMessage(clientId, message) {
    if (!message || typeof message !== "object") return;

    if (message.type === "queue_status") {
      emitQueueStatus(clientId);
      return;
    }

    if (message.type === "find_match") {
      handleFindMatch(clientId, message);
      return;
    }

    if (message.type === "create_room") {
      handleCreateRoom(clientId, message);
      return;
    }

    if (message.type === "join_room") {
      handleJoinRoom(clientId, message);
      return;
    }

    if (message.type === "room_message") {
      handleRoomMessage(clientId, message);
      return;
    }

    if (message.type === "cancel_match") {
      handleCancelMatch(clientId);
      return;
    }

    if (message.type === "leave_room") {
      leaveCurrentRoom(clientId, "left", true);
    }
  }

  function handleClientMessage(clientId, message) {
    try {
      return routeClientMessage(clientId, message);
    } catch (error) {
      emit(clientId, {
        event: "error",
        code: "INTERNAL",
        message: "Something went wrong in that match",
      });
      console.error(`[circuit-siege] ${message?.type ?? "message"} from ${clientId}:`, error);
      return undefined;
    }
  }

  function handleClientDisconnect(clientId, reason = "disconnect") {
    store.removeQueuedClient(clientId);
    leaveCurrentRoom(clientId, reason, false);
  }

  function sweepActiveRooms() {
    for (const room of store.listRooms()) {
      const result = room.engine.tick(now());
      if (!result.ok) continue;

      broadcastSnapshot(room, result.snapshot);
      if (result.snapshot.phase === "ended") {
        store.deleteRoom(room.roomCode);
      }
    }
  }

  function tickActiveRooms() {
    try {
      sweepActiveRooms();
    } catch (error) {
      console.error("[circuit-siege] heartbeat:", error);
    }
  }

  return {
    handleClientMessage,
    handleClientDisconnect,
    tickActiveRooms,
    hasRoomCode(roomCode) {
      return store.hasRoomCode(roomCode);
    },
    ownsClient(clientId) {
      return store.isQueuedClient(clientId) || !!store.getRoomCodeForClient(clientId);
    }
  };
}
