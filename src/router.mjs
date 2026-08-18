// WebSocket message router. A dispatch table keyed by message `type` replaces
// the old monolithic if-chain. Self-owning game bridges (Circuit Siege) get
// first crack at every message; lobby games are reached through the generic
// lobby handlers + the registry.
import {
  clients,
  clientRooms,
  clientSides,
  clientQueueWatch,
  clientLobbies,
  clientSessionTokens,
  rooms,
  roomGameIds,
  matchQueues,
  lobbies,
  suspendedLobbySessions,
} from "./state.mjs";
import { send, sendToClient, uniqueRoomCode } from "./transport.mjs";
import { sanitizeRoomGameId, sanitizeLobbyGameId, sanitizeLobbyLimits } from "./util.mjs";
import { validateClientFrame } from "./protocol.mjs";
import {
  setClientSide,
  leaveQueue,
  broadcastQueueStatus,
  getGameIdFromQueueKey,
  claimQueuedOpponent,
  enqueueMatchClient,
  sendQueueStatus,
  assignSideForStrategy,
} from "./matchmaking.mjs";
import { leaveRoom, joinRoom, broadcastToRoom, emitMatchReady } from "./rooms.mjs";
import {
  createLobby,
  joinLobby,
  findOpenLobby,
  updateLobbySettings,
  requestStartLobby,
  leaveLobby,
  leaveDisplayLobby,
  suspendLobbyClient,
  resumeLobbyClient,
  broadcastToLobby,
  rememberLobbyIdentity,
  sendLobbyUpdated,
} from "./lobby.mjs";
import {
  lobbyGame,
  matchmakingStrategy,
  routeToBridge,
  bridgeOwningClient,
} from "../games/registry.mjs";

// Each handler receives { clientId, ws, data }.
const handlers = {
  create_lobby({ clientId, data }) {
    createLobby(clientId, data, { isPrivate: !!data.private, displayOnly: data.role === "display" });
  },

  join_lobby({ clientId, data }) {
    joinLobby(clientId, data.roomCode, data.identity);
  },

  find_lobby({ clientId, data }) {
    const gameId = sanitizeLobbyGameId(data.gameId);
    const limits = sanitizeLobbyLimits(data.minPlayers, data.maxPlayers);
    const existing = findOpenLobby(gameId, limits, data.settings);
    if (existing) {
      joinLobby(clientId, existing.roomCode, data.identity);
    } else {
      createLobby(clientId, {
        ...data,
        gameId,
        settings: data.settings,
      }, { isPrivate: false });
    }
  },

  update_lobby_settings({ clientId, data }) {
    updateLobbySettings(clientId, data);
  },

  start_lobby({ clientId }) {
    requestStartLobby(clientId);
  },

  leave_lobby({ clientId }) {
    leaveLobby(clientId, "left");
  },

  resume_lobby({ clientId, ws, data, connection }) {
    const previousClientId = String(data.clientId || "");
    const sessionToken = String(data.sessionToken || "");
    const lobby = resumeLobbyClient(clientId, previousClientId, sessionToken);
    if (!lobby) {
      send(ws, { event: "error", code: "RESUME_REJECTED", message: "That reconnect session is no longer available." });
      return;
    }
    clients.delete(clientId);
    clientSessionTokens.delete(clientId);
    clients.set(previousClientId, ws);
    if (connection) connection.clientId = previousClientId;
    const game = lobbyGame(lobby.gameId);
    if (game?.applyReconnect) game.broadcastAfterReconnect?.(lobby) || game.broadcastAfterLeave?.(lobby);
    else sendLobbyUpdated(lobby);
    send(ws, {
      event: "session_resumed",
      clientId: previousClientId,
      sessionToken: clientSessionTokens.get(previousClientId),
      roomCode: lobby.roomCode,
    });
  },

  lobby_message({ clientId, ws, data }) {
    const roomCode = clientLobbies.get(clientId);
    if (!roomCode) {
      send(ws, { event: "error", code: "NOT_IN_LOBBY", message: "You are not in a lobby" });
      return;
    }

    const lobby = lobbies.get(roomCode);
    const messageType = String(data.messageType || "");
    const value = String(data.value ?? "");
    const game = lobbyGame(lobby?.gameId);

    if (game) {
      if (messageType === "profile") {
        let profile = null;
        try { profile = JSON.parse(value); } catch { profile = null; }
        rememberLobbyIdentity(lobby, clientId, profile);
      }

      const result = game.handleMessage?.(lobby, clientId, messageType, value) || { handled: false };
      if (result.error) {
        send(ws, { event: "error", code: result.error.code, message: result.error.message });
        return;
      }
      if (result.handled) return;
    }

    broadcastToLobby(roomCode, {
      event: "message",
      scope: "lobby",
      messageType,
      value,
      senderId: clientId,
      roomCode,
    });
  },

  create_room({ clientId, ws, data }) {
    const gameId = sanitizeRoomGameId(data.gameId);
    const currentRoom = clientRooms.get(clientId);
    if (currentRoom) leaveRoom(clientId, "create_new_room");
    leaveLobby(clientId, "create_room");
    setClientSide(clientId, data.side);

    const roomCode = uniqueRoomCode();
    const members = new Set([clientId]);
    rooms.set(roomCode, members);
    roomGameIds.set(roomCode, gameId);
    clientRooms.set(clientId, roomCode);

    send(ws, { event: "room_joined", roomCode, playerCount: 1, created: true });
  },

  join_room({ clientId, data }) {
    const roomCode = String(data.roomCode || "").trim().toUpperCase();
    joinRoom(clientId, roomCode, data.side, data.gameId);
  },

  leave_room({ clientId }) {
    leaveRoom(clientId, "left");
  },

  room_message({ clientId, ws, data }) {
    const roomCode = clientRooms.get(clientId);
    if (!roomCode) {
      send(ws, { event: "error", code: "NOT_IN_ROOM", message: "You are not in a room" });
      return;
    }

    const messageType = String(data.messageType || "");
    const value = String(data.value ?? "");

    broadcastToRoom(roomCode, {
      event: "message",
      scope: "room",
      messageType,
      value,
      senderId: clientId,
      roomCode,
    });
  },

  direct_message({ clientId, ws, data }) {
    const targetId = String(data.targetId || "");
    const messageType = String(data.messageType || "");
    const value = String(data.value ?? "");

    if (!clients.has(targetId)) {
      send(ws, { event: "error", code: "CLIENT_NOT_FOUND", message: "Target client does not exist" });
      return;
    }

    sendToClient(targetId, {
      event: "message",
      scope: "direct",
      messageType,
      value,
      senderId: clientId,
    });
  },

  find_match({ clientId, ws, data }) {
    const gameId = String(data.gameId || "default");

    // The game's matchmaking strategy decides the side (e.g. symmetric games
    // auto-balance the shorter queue); generic code never names a game.
    const requestedSide = assignSideForStrategy(matchmakingStrategy(gameId), gameId, data.side, matchQueues);

    const side = setClientSide(clientId, requestedSide);
    clientQueueWatch.set(clientId, gameId);
    const currentRoom = clientRooms.get(clientId);
    if (currentRoom) leaveRoom(clientId, "find_match");
    leaveLobby(clientId, "find_match");
    leaveDisplayLobby(clientId, "find_match");
    const removedQueueKey = leaveQueue(clientId);
    if (removedQueueKey) broadcastQueueStatus(getGameIdFromQueueKey(removedQueueKey));

    const opponentId = claimQueuedOpponent(matchQueues, gameId, side);
    if (opponentId) {
      broadcastQueueStatus(gameId);

      const roomCode = uniqueRoomCode();
      rooms.set(roomCode, new Set([opponentId, clientId]));
      roomGameIds.set(roomCode, gameId);
      clientRooms.set(opponentId, roomCode);
      clientRooms.set(clientId, roomCode);

      sendToClient(opponentId, { event: "room_joined", roomCode, playerCount: 2 });
      sendToClient(clientId,   { event: "room_joined", roomCode, playerCount: 2 });
      sendToClient(opponentId, { event: "player_joined", clientId,             roomCode, playerCount: 2 });
      sendToClient(clientId,   { event: "player_joined", clientId: opponentId, roomCode, playerCount: 2 });
      emitMatchReady(roomCode);
    } else {
      enqueueMatchClient(matchQueues, gameId, side, clientId);
      broadcastQueueStatus(gameId);
      send(ws, { event: "searching", gameId, ...(side ? { side } : {}) });
    }
  },

  queue_status({ clientId, data }) {
    const gameId = String(data.gameId || "default");
    clientQueueWatch.set(clientId, gameId);
    sendQueueStatus(clientId, gameId);
  },

  cancel_match({ clientId, ws }) {
    const removedQueueKey = leaveQueue(clientId);
    if (removedQueueKey) broadcastQueueStatus(getGameIdFromQueueKey(removedQueueKey));
    send(ws, { event: "search_cancelled" });
  },

  ping({ ws }) {
    send(ws, { event: "pong" });
  },
};

export function handleClientMessage(clientId, ws, raw, connection = null) {
  let data;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    send(ws, { event: "error", code: "BAD_JSON", message: "Invalid JSON" });
    return;
  }

  const validation = validateClientFrame(data);
  if (!validation.ok) {
    send(ws, { event: "error", code: "BAD_MESSAGE", message: validation.message });
    return;
  }

  try {
    dispatchClientMessage(clientId, ws, data, connection);
  } catch (error) {
    send(ws, { event: "error", code: "INTERNAL", message: "Something went wrong while handling that message" });
    console.error(`[router] ${String(data.type || "message")} from ${clientId}:`, error);
  }
}

function dispatchClientMessage(clientId, ws, data, connection) {
  // Self-owning game bridges (e.g. Circuit Siege) get first claim on a message.
  const bridge = routeToBridge(clientId, data);
  if (bridge) {
    bridge.handleClientMessage(clientId, data);
    return;
  }

  const handler = handlers[data.type];
  if (!handler) {
    send(ws, { event: "error", code: "UNKNOWN_TYPE", message: "Unknown message type" });
    return;
  }
  handler({ clientId, ws, data, connection });
}

export function handleClientDisconnect(clientId, reason) {
  // A socket may emit both `error` and `close`. If the first event suspended a
  // reconnectable seat, the second event must not immediately evict it.
  if (!clients.has(clientId) && suspendedLobbySessions.has(clientId)) return;

  try {
    const bridge = bridgeOwningClient(clientId);
    if (bridge) {
      bridge.handleClientDisconnect(clientId, reason);
    } else {
      const removedQueueKey = leaveQueue(clientId);
      if (removedQueueKey) broadcastQueueStatus(getGameIdFromQueueKey(removedQueueKey));
      leaveRoom(clientId, reason);
    }
  } catch (error) {
    console.error(`[router] disconnect for ${clientId}:`, error);
  }

  try {
    if (!suspendLobbyClient(clientId, reason)) leaveLobby(clientId, reason);
    leaveDisplayLobby(clientId, reason);
  } catch (error) {
    console.error(`[router] lobby disconnect for ${clientId}:`, error);
  } finally {
    clientSides.delete(clientId);
    clientQueueWatch.delete(clientId);
    clients.delete(clientId);
    if (!suspendedLobbySessions.has(clientId)) clientSessionTokens.delete(clientId);
  }
}
