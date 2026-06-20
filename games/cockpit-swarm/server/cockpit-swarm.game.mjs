// Cockpit Swarm game definition. Symmetric 1v1 (p1/p2) with server-balanced side
// assignment so any two searchers pair. No server-side match logic.
const GAME_IDS = new Set(["cockpit-swarm", "cockpit-swarm-ranked"]);

export const definition = {
  matches: (gameId) => GAME_IDS.has(gameId),
  matchmaking: { strategy: "symmetric-balanced", sides: ["p1", "p2"] },
};
