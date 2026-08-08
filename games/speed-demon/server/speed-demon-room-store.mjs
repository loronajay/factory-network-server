// Room and queue bookkeeping for Speed Demon.
//
// Deliberately thinner than circuit-siege's equivalent: a drag race has no
// asymmetric roles, so there is one queue rather than one per side. Whoever is
// waiting races whoever turns up next.

export function createSpeedDemonRoomStore() {
  const queue = [];
  const queuedByClientId = new Map();
  const roomByCode = new Map();
  const roomCodeByClientId = new Map();

  function getQueueCounts() {
    return { waiting: queue.length, queueCounts: { any: queue.length } };
  }

  function enqueue(entry) {
    removeQueuedClient(entry.clientId);
    queue.push(entry);
    queuedByClientId.set(entry.clientId, entry);
  }

  /** The next driver waiting, if there is one. */
  function takeQueuedOpponent() {
    const opponent = queue.shift() || null;
    if (opponent) queuedByClientId.delete(opponent.clientId);
    return opponent;
  }

  function removeQueuedClient(clientId) {
    if (!queuedByClientId.has(clientId)) return;
    queuedByClientId.delete(clientId);
    const index = queue.findIndex((entry) => entry.clientId === clientId);
    if (index >= 0) queue.splice(index, 1);
  }

  function isQueuedClient(clientId) {
    return queuedByClientId.has(clientId);
  }

  /** Everyone currently waiting — the only clients a queue count is news to. */
  function listQueuedClientIds() {
    return queue.map((entry) => entry.clientId);
  }

  function createRoom(roomCode, record) {
    roomByCode.set(roomCode, record);
    return record;
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

  function removeClientFromRoom(clientId) {
    roomCodeByClientId.delete(clientId);
  }

  function deleteRoom(roomCode) {
    const room = roomByCode.get(roomCode);
    if (!room) return;
    roomByCode.delete(roomCode);
    for (const clientId of room.memberClientIds) roomCodeByClientId.delete(clientId);
  }

  function listRooms() {
    return [...roomByCode.values()];
  }

  return {
    getQueueCounts,
    enqueue,
    takeQueuedOpponent,
    removeQueuedClient,
    isQueuedClient,
    listQueuedClientIds,
    createRoom,
    getRoom,
    hasRoomCode,
    assignClientToRoom,
    getRoomForClient,
    getRoomCodeForClient,
    removeClientFromRoom,
    deleteRoom,
    listRooms,
  };
}
