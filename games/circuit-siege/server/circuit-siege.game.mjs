// Circuit Siege game definition. A self-owning bridge: it manages its own rooms,
// queues and match state, and intercepts the relevant client messages directly
// rather than going through the generic room/lobby code.
import { createBoardCatalog } from "./board-catalog.mjs";
import { createCircuitSiegeServerBridge } from "./circuit-siege-server-bridge.mjs";

const GAME_ID = "circuit-siege";

export const definition = {
  id: GAME_ID,
  matchmaking: { strategy: "self-owned" },
  bridge: {
    // Instantiated lazily by the registry, which supplies a collision-free
    // createRoomCode (checking rooms, lobbies and every bridge), sendToClient,
    // and a clock.
    create({ createRoomCode, sendToClient, now }) {
      const boardCatalog = createBoardCatalog();
      return createCircuitSiegeServerBridge({
        selectBoard: () => boardCatalog.selectBoard(),
        now,
        createRoomCode,
        sendToClient,
      });
    },
    // Does this message belong to a Circuit Siege session?
    shouldRoute(clientId, data, bridge) {
      const type = String(data?.type || "");
      const gameId = String(data?.gameId || "");

      if (type === "find_match" || type === "queue_status" || type === "create_room") {
        return gameId === GAME_ID;
      }
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
