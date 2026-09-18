// Arcade Room presence definition. A self-owning bridge with no matchmaking: it
// claims every `arcade_room_*` frame and nothing else, so a client standing in
// an arcade can still `ping` through the generic handler.
import { createArcadeRoomPresenceBridge } from "./arcade-room-presence-bridge.mjs";

const GAME_ID = "arcade-room";
const MESSAGE_PREFIX = "arcade_room_";

export const definition = {
  id: GAME_ID,
  matchmaking: { strategy: "self-owned" },
  bridge: {
    create({ sendToClient, now }) {
      return createArcadeRoomPresenceBridge({ sendToClient, now });
    },
    shouldRoute(_clientId, data) {
      return String(data?.type || "").startsWith(MESSAGE_PREFIX);
    },
  },
};
