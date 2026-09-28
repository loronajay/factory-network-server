// The Pet Games rival pool: every CPU pet a player can meet, as DATA.
//
// Pure — no DOM, no clock, no ambient random — because the network server
// mirrors this folder (games/pet-games/tools/mirror-sim.mjs) and seats these
// same rivals in online lobbies that asked for CPU guests. A rival is a named
// pet with a fixed species, coat and stats; it never borrows the player's pet
// numbers, so a farm pet's progression is a real (narrow) advantage.
//
// `tier` is how seasoned the rival is. Difficulty is decided by the CPU's
// HANDS (each event's cpu.js reads its level's knobs) — the tier only shapes
// which faces a level tends to field, so a Champion grid looks like one.

export const SPECIES_IDS = Object.freeze([
  "pet.corgi", "pet.duck", "pet.red-panda", "pet.platypus", "pet.hippo",
  "pet.rhino", "pet.bat", "pet.shark", "pet.anglerfish", "pet.jellyfish",
]);

// Every coat each species ships with (js/farm-catalog/animals.mts); a test holds them equal.
export const SPECIES_PALETTES = Object.freeze({
  "pet.corgi": Object.freeze(["standard", "sable", "midnight", "cosmic"]),
  "pet.duck": Object.freeze(["standard", "mallard", "lavender", "prism"]),
  "pet.red-panda": Object.freeze(["standard", "golden", "silver", "celestial"]),
  "pet.platypus": Object.freeze(["standard", "copper", "moonstone", "opaline"]),
  "pet.hippo": Object.freeze(["standard", "rosy", "slate", "nebula"]),
  "pet.rhino": Object.freeze(["standard", "ochre", "frost", "crystal"]),
  "pet.bat": Object.freeze(["standard", "ember", "ghost", "eclipse"]),
  "pet.shark": Object.freeze(["standard", "tiger", "albino", "voidfin"]),
  "pet.anglerfish": Object.freeze(["standard", "ember", "abyss", "biolume"]),
  "pet.jellyfish": Object.freeze(["standard", "sunset", "aurora", "starborn"]),
});

function rival(id, name, speciesId, paletteId, tier, speed, strength, size, farm) {
  return Object.freeze({
    id: `rival.${id}`,
    name,
    speciesId,
    paletteId,
    tier,
    farm,
    stats: Object.freeze({ speed, strength, size }),
  });
}

/** Forty-two rivals from a dozen neighbouring farms. Tier 1 are locals, tier 3 the circuit's best. */
export const RIVALS = Object.freeze([
  // Tier 1 — county-fair regulars.
  rival("pepper", "Pepper", "pet.corgi", "standard", 1, 44, 38, 0.96, "Hollow Creek"),
  rival("maple", "Maple", "pet.red-panda", "standard", 1, 40, 42, 1, "Maplewood"),
  rival("tumble", "Tumble", "pet.duck", "standard", 1, 48, 30, 0.94, "Reedy Bend"),
  rival("mochi", "Mochi", "pet.platypus", "standard", 1, 36, 46, 1, "Stillwater"),
  rival("clover", "Clover", "pet.corgi", "sable", 1, 42, 40, 1.02, "Clover Hill"),
  rival("pudding", "Pudding", "pet.hippo", "standard", 1, 30, 52, 1, "Muddy Acre"),
  rival("wisp", "Wisp", "pet.bat", "standard", 1, 50, 28, 0.95, "Old Belfry"),
  rival("bramble", "Bramble", "pet.rhino", "standard", 1, 32, 54, 0.98, "Thornfield"),
  rival("puddle", "Puddle", "pet.jellyfish", "standard", 1, 38, 36, 1, "Glassmere"),
  rival("nibbles", "Nibbles", "pet.anglerfish", "standard", 1, 40, 38, 0.97, "Deepwell"),
  rival("sprout", "Sprout", "pet.duck", "mallard", 1, 46, 34, 1, "Greenmeadow"),
  rival("biscotti", "Biscotti", "pet.corgi", "standard", 1, 45, 36, 0.93, "Oven Lane"),
  rival("fennel", "Fennel", "pet.red-panda", "golden", 1, 43, 39, 0.99, "Herb Row"),
  rival("gumdrop", "Gumdrop", "pet.hippo", "rosy", 1, 34, 50, 1.03, "Candy Pond"),
  // Tier 2 — regional contenders.
  rival("comet", "Comet", "pet.bat", "ember", 2, 62, 40, 1, "Starfall Ridge"),
  rival("dash", "Dash", "pet.corgi", "midnight", 2, 60, 50, 1.02, "Crossroads"),
  rival("sable", "Sable", "pet.red-panda", "silver", 2, 58, 52, 1, "Silverpine"),
  rival("ripple", "Ripple", "pet.platypus", "copper", 2, 54, 58, 1.01, "Copper Creek"),
  rival("thunder", "Thunder", "pet.rhino", "ochre", 2, 48, 70, 1.04, "Stormgate"),
  rival("bubbles", "Bubbles", "pet.hippo", "slate", 2, 46, 68, 1.05, "Slate Quarry"),
  rival("finley", "Finley", "pet.shark", "tiger", 2, 60, 56, 1, "Tiger Cove"),
  rival("lantern", "Lantern", "pet.anglerfish", "ember", 2, 56, 54, 1, "Lamplight Bay"),
  rival("marigold", "Marigold", "pet.duck", "lavender", 2, 64, 44, 0.98, "Lavender Hill"),
  rival("glimmer", "Glimmer", "pet.jellyfish", "sunset", 2, 58, 50, 1, "Sunset Shoals"),
  rival("rascal", "Rascal", "pet.corgi", "sable", 2, 63, 48, 0.97, "Fox Hollow"),
  rival("pistachio", "Pistachio", "pet.platypus", "moonstone", 2, 55, 60, 1.02, "Nutgrove"),
  rival("hazel", "Hazel", "pet.red-panda", "golden", 2, 61, 51, 0.99, "Hazelwood"),
  rival("boulder", "Boulder", "pet.rhino", "frost", 2, 50, 66, 1.06, "Frost Hollow"),
  // Tier 3 — the circuit's best.
  rival("blitz", "Blitz", "pet.corgi", "cosmic", 3, 80, 62, 1, "Cosmos Downs"),
  rival("valkyrie", "Valkyrie", "pet.bat", "eclipse", 3, 84, 58, 1.02, "Eclipse Spire"),
  rival("tsunami", "Tsunami", "pet.shark", "voidfin", 3, 76, 74, 1.04, "Void Reef"),
  rival("duchess", "Duchess", "pet.duck", "prism", 3, 82, 60, 1, "Prism Lake"),
  rival("atlas", "Atlas", "pet.rhino", "crystal", 3, 66, 90, 1.08, "Crystal Crag"),
  rival("nova", "Nova", "pet.red-panda", "celestial", 3, 80, 66, 1.01, "Celestia Farm"),
  rival("big-mama", "Big Mama", "pet.hippo", "nebula", 3, 62, 88, 1.1, "Nebula Marsh"),
  rival("opal", "Opal", "pet.platypus", "opaline", 3, 78, 70, 1.03, "Opal Springs"),
  rival("abyss", "Abyss", "pet.anglerfish", "biolume", 3, 76, 72, 1.02, "Biolume Trench"),
  rival("stardust", "Stardust", "pet.jellyfish", "starborn", 3, 79, 68, 1, "Starborn Lagoon"),
  rival("ghostly", "Ghostly", "pet.bat", "ghost", 3, 83, 61, 0.98, "Hollow Manor"),
  rival("fang", "Fang", "pet.shark", "albino", 3, 74, 78, 1.05, "Whitecap Point"),
  rival("sovereign", "Sovereign", "pet.corgi", "midnight", 3, 81, 67, 1.04, "Crown Meadow"),
  rival("tempest", "Tempest", "pet.duck", "lavender", 3, 85, 57, 0.97, "Gale Fields"),
]);

const BY_ID = new Map(RIVALS.map((entry) => [entry.id, entry]));

export function findRival(id) {
  return BY_ID.get(id) ?? null;
}

/** A 32-bit FNV-1a hash of any text: the only source of variety in this folder. */
export function hashText(text) {
  let value = 2166136261;
  for (const character of String(text)) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value >>> 0;
}

/** A deterministic 0..1 sample from a seed and any number of salts. */
export function noise(seed, ...salts) {
  let value = hashText(`${seed}:${salts.join(":")}`);
  value = Math.imul(value ^ (value >>> 15), 2246822507) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 3266489909) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

// Which tiers a level draws from, most likely first. A Rookie grid is mostly
// locals with a contender or two; a Champion grid is mostly the circuit's best.
const TIER_WEIGHTS = Object.freeze({
  rookie: Object.freeze({ 1: 7, 2: 3, 3: 0 }),
  pro: Object.freeze({ 1: 2, 2: 6, 3: 2 }),
  champion: Object.freeze({ 1: 0, 2: 3, 3: 7 }),
});

/**
 * Pick `count` distinct rivals for a field, deterministically from `seed`.
 * `exclude` holds rival ids already seated (a Grand Prix keeps its grid).
 */
export function pickRivals({ seed = "field", count = 3, level = "pro", exclude = [] } = {}) {
  const total = Math.max(0, Math.min(RIVALS.length, Math.floor(Number(count) || 0)));
  const weights = TIER_WEIGHTS[level] ?? TIER_WEIGHTS.pro;
  const skip = new Set(exclude);
  const ranked = RIVALS
    .filter((entry) => !skip.has(entry.id))
    .map((entry) => {
      const weight = weights[entry.tier] ?? 0;
      // Weighted shuffle (Efraimidis–Spirakis): a larger key sorts first.
      const sample = Math.max(1e-9, noise(seed, entry.id));
      return { entry, key: weight > 0 ? Math.log(sample) / weight : -Infinity };
    })
    .sort((left, right) => right.key - left.key || left.entry.id.localeCompare(right.entry.id));
  return ranked.slice(0, total).map((row) => row.entry);
}

/** A rival as the view model every event plays: the same shape as a farm pet. */
export function rivalAsPet(entry) {
  return {
    instanceId: entry.id,
    speciesId: entry.speciesId,
    name: entry.name,
    paletteId: entry.paletteId,
    farm: entry.farm,
    stats: { ...entry.stats },
  };
}

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

/**
 * The only shape a pet may cross a trust boundary in (an online lobby, a
 * result). Unknown species fall back to a corgi, a coat that species does not
 * have falls back to its standard one, and every stat is held to the farm's range.
 */
export function sanitizePet(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const speciesId = SPECIES_IDS.includes(source.speciesId) ? source.speciesId : "pet.corgi";
  const palettes = SPECIES_PALETTES[speciesId];
  const name = typeof source.name === "string" ? source.name.replace(/\s+/g, " ").trim().slice(0, 20) : "";
  const stats = source.stats && typeof source.stats === "object" ? source.stats : {};
  return {
    instanceId: typeof source.instanceId === "string" ? source.instanceId.slice(0, 64) : "",
    speciesId,
    name: name || "Farm Pet",
    paletteId: palettes.includes(source.paletteId) ? source.paletteId : "standard",
    stats: {
      speed: clampNumber(stats.speed, 0, 100, 50),
      strength: clampNumber(stats.strength, 0, 100, 50),
      size: clampNumber(stats.size, 0.62, 1.12, 1),
    },
  };
}
