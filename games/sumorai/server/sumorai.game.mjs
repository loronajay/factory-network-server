// Sumorai game definition. Server provides deterministic match settings (a
// seeded stage plan + rules version) at match start; otherwise it's a standard
// side-paired 1v1 relay game.
const GAME_IDS = new Set(["sumorai", "sumorai-ranked"]);

function buildSumoraiStagePlan(seed, rounds = 5) {
  const stages = ["single", "battlefield", "battlefield", "moving", "none"];
  const normalizedSeed = Number.isFinite(Number(seed)) ? Number(seed) : 0;
  return Array.from({ length: rounds }, (_, index) => {
    const roundNum = index + 1;
    const stageIndex = Math.abs(Math.floor(normalizedSeed * 9301 + roundNum * 49297)) % stages.length;
    return stages[stageIndex];
  });
}

export const definition = {
  matches: (gameId) => GAME_IDS.has(gameId),
  matchmaking: { strategy: "side-pair" },
  matchSettings(seed) {
    const normalizedSeed = Number.isFinite(Number(seed)) ? Number(seed) : 0;
    return {
      rulesVersion: "sumorai-online-v1",
      seed: normalizedSeed,
      roundTarget: 3,
      stagePlan: buildSumoraiStagePlan(normalizedSeed, 5),
    };
  },
};
