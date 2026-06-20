// 1v1 room lifecycle: join/leave, broadcast, and the room-side of match_ready.
// joinRoom intentionally evicts the client from any lobby first, which creates a
// rooms <-> lobby import cycle; it is safe because the reference is only used
// inside function bodies (ESM resolves the binding lazily at call time).
import {
  rooms,
  roomGameIds,
  clientRooms,
  clientSides,
  MAX_PLAYERS_PER_ROOM,
  MATCH_READY_DELAY_MS,
} from "./state.mjs";
import { sendToClient } from "./transport.mjs";
import { sanitizeRoomGameId } from "./util.mjs";
import {
  normalizeMatchSide,
  buildMatchReadyMessages,
  makeMatchSeed,
  setClientSide,
} from "./matchmaking.mjs";
import { leaveLobby } from "./lobby.mjs";

export function broadcastToRoom(roomCode, payload, exceptClientId = null) {
  const members = rooms.get(roomCode);
  if (!members) return;

  for (const memberId of members) {
    if (memberId === exceptClientId) continue;
    sendToClient(memberId, payload);
  }
}

export function getPlayerCount(roomCode) {
  const members = rooms.get(roomCode);
  return members ? members.size : 0;
}

export function getRoomMemberIds(roomCode) {
  const members = rooms.get(roomCode);
  return members ? [...members] : [];
}

export function sameSideAlreadyInRoom(roomCode, side) {
  const normalized = normalizeMatchSide(side);
  if (!normalized) return false;
  return getRoomMemberIds(roomCode).some(memberId => clientSides.get(memberId) === normalized);
}

export function emitMatchReady(roomCode) {
  const [clientAId, clientBId] = getRoomMemberIds(roomCode);
  if (!clientAId || !clientBId) return false;
  const gameId = roomGameIds.get(roomCode) || null;

  const messages = buildMatchReadyMessages(
    clientAId,
    clientSides.get(clientAId),
    clientBId,
    clientSides.get(clientBId),
    Date.now(),
    MATCH_READY_DELAY_MS,
    makeMatchSeed(),
    gameId,
  );
  if (!messages) return false;

  for (const { clientId, payload } of messages) {
    sendToClient(clientId, { ...payload, roomCode });
  }
  return true;
}

export function leaveRoom(clientId, reason = "left") {
  const roomCode = clientRooms.get(clientId);
  if (!roomCode) return;

  const members = rooms.get(roomCode);
  if (members) {
    members.delete(clientId);

    broadcastToRoom(roomCode, {
      event: "player_left",
      clientId,
      roomCode,
      playerCount: members.size,
      reason
    });

    if (members.size === 0) {
      rooms.delete(roomCode);
      roomGameIds.delete(roomCode);
    }
  }

  clientRooms.delete(clientId);

  sendToClient(clientId, {
    event: "room_left",
    roomCode
  });
}

export function joinRoom(clientId, roomCode, side, gameId = null) {
  if (!roomCode || !rooms.has(roomCode)) {
    sendToClient(clientId, {
      event: "error",
      code: "ROOM_NOT_FOUND",
      message: "Room does not exist"
    });
    return;
  }

  const currentRoom = clientRooms.get(clientId);
  if (currentRoom === roomCode) {
    sendToClient(clientId, {
      event: "room_joined",
      roomCode,
      playerCount: getPlayerCount(roomCode)
    });
    return;
  }

  const members = rooms.get(roomCode);
  const existingGameId = roomGameIds.get(roomCode) || "default";
  const requestedGameId = gameId ? sanitizeRoomGameId(gameId) : null;

  if (requestedGameId && existingGameId !== "default" && requestedGameId !== existingGameId) {
    sendToClient(clientId, {
      event: "error",
      code: "ROOM_GAME_MISMATCH",
      message: "Room belongs to a different game"
    });
    return;
  }

  if (members.size >= MAX_PLAYERS_PER_ROOM) {
    sendToClient(clientId, {
      event: "error",
      code: "ROOM_FULL",
      message: "Room is full"
    });
    return;
  }

  if (sameSideAlreadyInRoom(roomCode, side)) {
    sendToClient(clientId, {
      event: "error",
      code: "SIDE_CONFLICT",
      message: "That side is already taken in this room"
    });
    return;
  }

  if (currentRoom) {
    leaveRoom(clientId, "switch_room");
  }

  leaveLobby(clientId, "join_room");

  setClientSide(clientId, side);
  if (requestedGameId && existingGameId === "default") roomGameIds.set(roomCode, requestedGameId);
  members.add(clientId);
  clientRooms.set(clientId, roomCode);

  sendToClient(clientId, {
    event: "room_joined",
    roomCode,
    playerCount: members.size
  });

  broadcastToRoom(roomCode, {
    event: "player_joined",
    clientId,
    roomCode,
    playerCount: members.size
  }, clientId);

  emitMatchReady(roomCode);
}
