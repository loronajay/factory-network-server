import { createOrbitPongServerBridge, ORBIT_PONG_GAME_ID } from "./orbit-pong-server-bridge.mjs";

export const definition = {
  id: ORBIT_PONG_GAME_ID,
  matchmaking: { strategy: "self-owned" },
  bridge: {
    create(context) {
      return createOrbitPongServerBridge(context);
    },
    shouldRoute(clientId, data, bridge) {
      const type = String(data?.type || "");
      const gameId = String(data?.gameId || "");
      if (type === "find_match" || type === "create_room") return gameId === ORBIT_PONG_GAME_ID;
      if (type === "join_room") {
        if (gameId === ORBIT_PONG_GAME_ID) return true;
        return bridge.hasRoomCode(data?.roomCode);
      }
      return ["cancel_match", "room_message", "leave_room"].includes(type) && bridge.ownsClient(clientId);
    },
  },
};
