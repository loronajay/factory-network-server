// Mini-Tactics game definition. Turn-based isometric squad tactics, 1v1 online.
//
// The match itself is host-authoritative over the generic relay (the
// cockpit-swarm pattern): there is NO server-side match logic here. The relay
// pairs two players (p1 = host, p2 = guest) and hands both the same `seed` at
// match start; the clients run the deterministic core in lockstep from that
// seed. Board size AND each player's squad composition are broadcast in-band
// (`setup` room_messages — the host carries size + its squad, the guest carries
// its squad; it's a blind pick), so they intentionally stay out of matchSettings
// — only the shared seed and a rules version travel through match_ready.
const GAME_IDS = new Set(["mini-tactics"]);

export const definition = {
  matches: (gameId) => GAME_IDS.has(gameId),
  // Symmetric seats: neither queue side has a fixed role, so the relay can
  // auto-balance which searcher becomes p1 (host) vs p2 (guest) — any two players
  // in the queue pair. (Squads may differ via blind-pick custom compositions, but
  // that is exchanged in-band after pairing and never affects matchmaking.)
  // The authoritative side is whatever match_ready reports, never a client claim.
  matchmaking: { strategy: "symmetric-balanced", sides: ["p1", "p2"] },
  matchSettings: (seed) => {
    const normalizedSeed = Number.isFinite(Number(seed)) ? Number(seed) : 0;
    return {
      rulesVersion: "mini-tactics-online-v1",
      seed: normalizedSeed,
    };
  },
};
