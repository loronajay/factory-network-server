import { createOrbitPongMatch } from "./orbit-pong-match.mjs";

export const ORBIT_PONG_GAME_ID = "orbit-pong";
const SNAPSHOT_EVERY_TICKS = 3;
const AUTHORITATIVE_MESSAGES = new Set(["score", "ball_hit", "match_end", "snapshot", "serve"]);

function parseValue(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try { return JSON.parse(value); } catch { return {}; }
}

export function createOrbitPongServerBridge({
  sendToClient,
  createRoomCode = () => Math.random().toString(36).slice(2, 7).toUpperCase(),
  makeSeed = () => Math.floor(Math.random() * 2 ** 31),
  scheduleInterval = (fn, ms) => setInterval(fn, ms),
} = {}) {
  const rooms = new Map();
  const roomByClient = new Map();
  const queue = [];
  const queued = new Map();

  const emit = (clientId, payload) => sendToClient(clientId, payload);
  const emitRoom = (room, payload) => room.clients.forEach((clientId) => emit(clientId, payload));

  function snapshotFor(room, clientId) {
    const snapshot = room.match.snapshot();
    if (!snapshot) return null;
    const playerIndex = room.match.playerIndex(clientId);
    return {
      ...snapshot,
      acknowledgedSequence: snapshot.acknowledgedSequences[playerIndex] ?? 0,
    };
  }

  function emitLobby(room) {
    for (const clientId of room.clients) {
      emit(clientId, {
        event: "op_lobby",
        roomCode: room.roomCode,
        private: room.private,
        players: room.match.players(),
        yourPlayerIndex: room.match.playerIndex(clientId),
      });
    }
  }

  function createRoom(isPrivate) {
    const roomCode = createRoomCode();
    const seed = makeSeed();
    const room = {
      roomCode,
      private: isPrivate,
      seed,
      match: createOrbitPongMatch({ seed }),
      clients: new Set(),
      timer: null,
    };
    rooms.set(roomCode, room);
    return room;
  }

  function identity(clientId, data) {
    return {
      playerId: typeof data?.playerId === "string" && data.playerId ? data.playerId : `guest-${clientId}`,
      displayName: typeof data?.displayName === "string" && data.displayName ? data.displayName : "Orbiter",
    };
  }

  function join(room, clientId, data) {
    const result = room.match.addPlayer(clientId, identity(clientId, data));
    if (!result.ok) {
      emit(clientId, { event: "error", code: result.code, message: "That room is full." });
      return false;
    }
    room.clients.add(clientId);
    roomByClient.set(clientId, room.roomCode);
    emit(clientId, { event: "room_joined", roomCode: room.roomCode, created: room.clients.size === 1 });
    emitLobby(room);
    return true;
  }

  function removeFromQueue(clientId) {
    if (!queued.has(clientId)) return false;
    queued.delete(clientId);
    const index = queue.indexOf(clientId);
    if (index >= 0) queue.splice(index, 1);
    return true;
  }

  function startRoom(room) {
    const started = room.match.start();
    if (!started.ok) return;
    for (const clientId of room.clients) {
      emit(clientId, {
        event: "op_match_started",
        roomCode: room.roomCode,
        seed: room.seed,
        players: room.match.players(),
        yourPlayerIndex: room.match.playerIndex(clientId),
        snapshot: snapshotFor(room, clientId),
      });
    }
    if (scheduleInterval) {
      room.timer = scheduleInterval(() => {
        try { advanceRoom(room); }
        catch (error) { console.error("[orbit-pong] tick:", error); }
      }, 1000 / 60);
      room.timer.unref?.();
    }
  }

  function stopRoom(room) {
    if (room.timer) clearInterval(room.timer);
    room.timer = null;
  }

  function advanceRoom(room) {
    if (!rooms.has(room.roomCode) || !room.match.started || room.match.complete) return false;
    const events = room.match.tick();
    const baseSnapshot = room.match.snapshot();
    if (baseSnapshot.tick % SNAPSHOT_EVERY_TICKS === 0 || events.length > 0) {
      for (const clientId of room.clients) {
        emit(clientId, { event: "op_snapshot", snapshot: snapshotFor(room, clientId) });
      }
    }
    const ended = events.find((event) => event.type === "MATCH_ENDED");
    if (ended) {
      stopRoom(room);
      for (const clientId of room.clients) {
        emit(clientId, {
          event: "op_match_ended",
          winnerId: ended.winnerId,
          snapshot: snapshotFor(room, clientId),
        });
      }
      return false;
    }
    return true;
  }

  function leaveRoom(clientId, reason = "left") {
    const roomCode = roomByClient.get(clientId);
    const room = rooms.get(roomCode);
    if (!room) return;
    const result = room.match.removePlayer(clientId);
    room.clients.delete(clientId);
    roomByClient.delete(clientId);
    emit(clientId, { event: "room_left", roomCode });
    if (room.clients.size === 0) {
      stopRoom(room);
      rooms.delete(roomCode);
      return;
    }
    emitRoom(room, { event: "player_left", roomCode, reason, playerCount: room.clients.size });
    if (result?.winnerId) {
      stopRoom(room);
      for (const remaining of room.clients) {
        emit(remaining, {
          event: "op_match_ended",
          winnerId: result.winnerId,
          reason: "forfeit",
          snapshot: snapshotFor(room, remaining),
        });
      }
    } else emitLobby(room);
  }

  function findMatch(clientId, data) {
    leaveRoom(clientId, "searching");
    removeFromQueue(clientId);
    const opponentId = queue.shift();
    if (!opponentId) {
      queue.push(clientId);
      queued.set(clientId, data);
      emit(clientId, { event: "searching", gameId: ORBIT_PONG_GAME_ID });
      return;
    }
    const opponentData = queued.get(opponentId) ?? {};
    queued.delete(opponentId);
    const room = createRoom(false);
    join(room, opponentId, opponentData);
    join(room, clientId, data);
  }

  function createPrivateRoom(clientId, data) {
    leaveRoom(clientId);
    removeFromQueue(clientId);
    join(createRoom(true), clientId, data);
  }

  function joinPrivateRoom(clientId, data) {
    const code = String(data?.roomCode || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      emit(clientId, { event: "error", code: "ROOM_NOT_FOUND", message: "No room has that code." });
      return;
    }
    leaveRoom(clientId);
    removeFromQueue(clientId);
    join(room, clientId, data);
  }

  function roomMessage(clientId, data) {
    const room = rooms.get(roomByClient.get(clientId));
    if (!room) return;
    const type = String(data?.messageType || "");
    const value = parseValue(data?.value);
    if (AUTHORITATIVE_MESSAGES.has(type)) {
      emit(clientId, { event: "error", code: "SERVER_AUTHORITY", message: "The server owns match outcomes." });
      return;
    }
    if (type === "ready") {
      room.match.setReady(clientId, value.ready !== false);
      emitLobby(room);
      if (room.match.everyoneReady()) startRoom(room);
    } else if (type === "input") {
      room.match.setInput(clientId, value);
    } else if (type === "ping") {
      emit(clientId, { event: "op_pong", sentAt: value.sentAt });
    }
  }

  function route(clientId, data) {
    switch (String(data?.type || "")) {
      case "find_match": return findMatch(clientId, data);
      case "cancel_match":
        removeFromQueue(clientId);
        return emit(clientId, { event: "search_cancelled" });
      case "create_room": return createPrivateRoom(clientId, data);
      case "join_room": return joinPrivateRoom(clientId, data);
      case "room_message": return roomMessage(clientId, data);
      case "leave_room": return leaveRoom(clientId);
      default: return undefined;
    }
  }

  function handleClientMessage(clientId, data) {
    try { return route(clientId, data); }
    catch (error) {
      emit(clientId, { event: "error", code: "INTERNAL", message: "That match could not continue." });
      console.error(`[orbit-pong] ${data?.type || "message"}:`, error);
      return undefined;
    }
  }

  function tickActiveRooms() {
    for (const room of rooms.values()) {
      if (!room.timer) {
        try { advanceRoom(room); }
        catch (error) { console.error("[orbit-pong] heartbeat:", error); }
      }
    }
  }

  return {
    handleClientMessage,
    handleClientDisconnect(clientId) {
      removeFromQueue(clientId);
      leaveRoom(clientId, "disconnected");
    },
    tickActiveRooms,
    ownsClient: (clientId) => queued.has(clientId) || roomByClient.has(clientId),
    hasRoomCode: (roomCode) => rooms.has(String(roomCode || "").trim().toUpperCase()),
  };
}
