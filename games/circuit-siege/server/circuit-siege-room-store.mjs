export function createCircuitSiegeRoomStore() {
  const queuedBySide = {
    blue: [],
    red: []
  };
  const roomByCode = new Map();
  const roomCodeByClientId = new Map();
  const queuedEntryByClientId = new Map();

  function getQueueCounts() {
    return {
      blueWaiting: queuedBySide.blue.length,
      redWaiting: queuedBySide.red.length
    };
  }

  function enqueue(entry) {
    removeQueuedClient(entry.clientId);
    queuedBySide[entry.side].push(entry);
    queuedEntryByClientId.set(entry.clientId, entry);
  }

  function takeQueuedOpponent(side) {
    const opponentSide = side === "blue" ? "red" : "blue";
    const opponent = queuedBySide[opponentSide].shift() || null;
    if (opponent) {
      queuedEntryByClientId.delete(opponent.clientId);
    }
    return opponent;
  }

  function removeQueuedClient(clientId) {
    const existing = queuedEntryByClientId.get(clientId);
    if (!existing) return;
    queuedEntryByClientId.delete(clientId);
    const queue = queuedBySide[existing.side];
    const index = queue.findIndex((entry) => entry.clientId === clientId);
    if (index >= 0) {
      queue.splice(index, 1);
    }
  }

  function createRoom(roomCode, roomRecord) {
    roomByCode.set(roomCode, roomRecord);
    return roomRecord;
  }

  function getRoom(roomCode) {
    return roomByCode.get(roomCode) || null;
  }

  function hasRoomCode(roomCode) {
    return roomByCode.has(roomCode);
  }

  function assignClientToRoom(clientId, roomCode) {
    roomCodeByClientId.set(clientId, roomCode);
  }

  function getRoomForClient(clientId) {
    const roomCode = roomCodeByClientId.get(clientId);
    return roomCode ? roomByCode.get(roomCode) || null : null;
  }

  function getRoomCodeForClient(clientId) {
    return roomCodeByClientId.get(clientId) || null;
  }

  function isQueuedClient(clientId) {
    return queuedEntryByClientId.has(clientId);
  }

  function removeClientFromRoom(clientId) {
    roomCodeByClientId.delete(clientId);
  }

  function deleteRoom(roomCode) {
    const room = roomByCode.get(roomCode);
    if (!room) return;
    roomByCode.delete(roomCode);
    for (const memberClientId of room.memberClientIds) {
      roomCodeByClientId.delete(memberClientId);
    }
  }

  function listRooms() {
    return [...roomByCode.values()];
  }

  return {
    getQueueCounts,
    enqueue,
    takeQueuedOpponent,
    removeQueuedClient,
    createRoom,
    getRoom,
    hasRoomCode,
    assignClientToRoom,
    getRoomForClient,
    getRoomCodeForClient,
    isQueuedClient,
    removeClientFromRoom,
    deleteRoom,
    listRooms
  };
}
