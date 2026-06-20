// Lobby messaging primitives — a leaf module (state + transport + util only).
// Lives apart from src/lobby.mjs so game adapters can broadcast without importing
// the full lobby lifecycle, which would create a lobby <-> registry import cycle.
import { lobbies } from "./state.mjs";
import { sendToClient } from "./transport.mjs";
import { lobbyPlayerCount } from "./util.mjs";

export function getLobbyMemberIds(roomCode) {
  const lobby = lobbies.get(roomCode);
  return lobby ? [...lobby.members] : [];
}

export function broadcastToLobby(roomCode, payload, exceptClientId = null) {
  const lobby = lobbies.get(roomCode);
  if (!lobby) return;

  for (const memberId of lobby.members) {
    if (memberId === exceptClientId) continue;
    sendToClient(memberId, payload);
  }
}

export function buildLobbyPayload(lobby) {
  return {
    roomCode: lobby.roomCode,
    gameId: lobby.gameId,
    ownerId: lobby.ownerId,
    playerCount: lobbyPlayerCount(lobby),
    minPlayers: lobby.minPlayers,
    maxPlayers: lobby.maxPlayers,
    status: lobby.status,
    isPrivate: !!lobby.isPrivate,
    settings: lobby.settings,
    members: lobby?.members ? [...lobby.members] : getLobbyMemberIds(lobby.roomCode),
    startAt: lobby.startAt || null,
  };
}

export function sendLobbyUpdated(lobby) {
  if (!lobby) return;
  broadcastToLobby(lobby.roomCode, {
    event: "lobby_updated",
    ...buildLobbyPayload(lobby),
  });
}
