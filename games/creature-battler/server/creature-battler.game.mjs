// Creature Battler game definition. A family of symmetric 1v1 games
// (creature-battler-fire, -water, ...) where the server auto-assigns the shorter
// side so any two searchers always pair. No server-side match logic.
export const definition = {
  matches: (gameId) => typeof gameId === "string" && gameId.startsWith("creature-battler-"),
  matchmaking: { strategy: "symmetric-balanced", sides: ["alpha", "beta"] },
};
