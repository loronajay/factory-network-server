// Windrush Downs race room definition. A self-owning bridge with no matchmaking:
// platform-api's race board decides who races; this claims every `downs_race_*`
// frame and runs the race.
import { createDownsRaceBridge } from "./downs-race-bridge.mjs";

const MESSAGE_PREFIX = "downs_race_";

export const definition = {
  id: "farm-downs",
  matchmaking: { strategy: "self-owned" },
  bridge: {
    create({ sendToClient, now }) {
      return createDownsRaceBridge({ sendToClient, now });
    },
    shouldRoute(_clientId, data) {
      return String(data?.type || "").startsWith(MESSAGE_PREFIX);
    },
  },
};
