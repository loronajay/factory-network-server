// Pure stat progression. Speed and Strength are no longer fixed at adoption:
// a pet is born with a base, a hidden per-stat growth RATE (points per farm day
// at perfect care) and earns `gained` every living day through the same
// persisted farm-time checkpoint as hunger, happiness and age.
//
// Three things decide how much a day is worth:
//   1. POTENTIAL — a grade rolled once at adoption. Most pets are Steady; a
//      Prodigy is a ~1% roll that palette rarity makes several times likelier.
//   2. LIFE STAGE — youth grows fastest, adulthood slower, elders keep their
//      peak but stop growing. Fast Grower speeds up youth.
//   3. CARE — hunger, happiness, hidden affection and hidden RAPPORT (how well
//      the pet has been treated the way its traits want) multiply every day.
//
// This module owns no catalog: species data is passed in, so the care catalog
// can import it without a cycle and the server can mirror the maths.
export const PET_GROWTH_GRADES = Object.freeze([
    Object.freeze({ id: "steady", title: "Steady", stars: 1, multiplier: 1 }),
    Object.freeze({ id: "gifted", title: "Gifted", stars: 2, multiplier: 1.35 }),
    Object.freeze({ id: "exceptional", title: "Exceptional", stars: 3, multiplier: 1.8 }),
    Object.freeze({ id: "prodigy", title: "Prodigy", stars: 4, multiplier: 2.5 }),
]);
/** Readable 100-point tables, in PET_GROWTH_GRADES order. Rarer looks lean toward higher potential. */
export const GROWTH_GRADE_WEIGHTS = Object.freeze({
    classic: Object.freeze([72, 21, 6, 1]),
    uncommon: Object.freeze([64, 26, 8, 2]),
    rare: Object.freeze([45, 33, 17, 5]),
    "super-rare": Object.freeze([25, 35, 28, 12]),
});
/** Life-stage boundaries as fractions of the species lifespan, with their growth weight. */
export const GROWTH_STAGES = Object.freeze([
    Object.freeze({ id: "youth", title: "Youth", until: 0.4, weight: 1.2 }),
    Object.freeze({ id: "adult", title: "Adult", until: 0.75, weight: 0.8 }),
    Object.freeze({ id: "elder", title: "Elder", until: Infinity, weight: 0 }),
]);
export const FAST_GROWER_YOUTH_BONUS = 1.25;
/** Share of the species' stat range a Steady pet gains over a lifetime of perfect care. */
export const GROWTH_BUDGET_SHARE = 0.9;
export const RATE_JITTER = Object.freeze({ min: 0.85, max: 1.15 });
export const STAT_CEILING = 100;
// Care factors. Each is 1.0 for a well-kept pet; affection and rapport can
// push past 1.0, which is how a bonded, well-understood pet out-grows its roll.
export const HAPPINESS_GROWTH_FLOOR = 10;
export const HAPPINESS_GROWTH_FULL = 80;
export const AFFINITY_FACTOR = Object.freeze({ min: 0.6, max: 1.3 });
export const RAPPORT_FACTOR = Object.freeze({ min: 0.7, max: 1.3 });
export const MAX_CARE_MULTIPLIER = AFFINITY_FACTOR.max * RAPPORT_FACTOR.max;
export const HUNGRY_GROWTH_WEIGHT = 0.5;
export const RAPPORT_NEUTRAL = 50;
export const RAPPORT_DRIFT_PER_DAY = 3;
/** The 1st, 2nd and 3rd treatment of one kind in a farm day count this much; later ones not at all. */
export const DAILY_TREATMENT_SCALE = Object.freeze([1, 0.6, 0.3]);
/** Pre-growth pets are credited for the days they already lived at this care level. */
export const LEGACY_CARE_MULTIPLIER = 0.8;
const STAT_IDS = Object.freeze(["speed", "strength"]);
const EMPTY_TREATS = Object.freeze({ pet: 0, carry: 0, play: 0, feed: 0 });
const unit = (value) => Number.isFinite(value) ? Math.min(0.999999, Math.max(0, value)) : 0;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, places) => Number(value.toFixed(places));
const bounded = (value, min, max, fallback) => typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
export function findGrowthGrade(id) {
    return PET_GROWTH_GRADES.find((grade) => grade.id === id) ?? PET_GROWTH_GRADES[0];
}
/** Weighted days of growth between two ages; elders contribute nothing. */
export function growthStageDays(fromAge, toAge, maxLifeDays, fastGrower) {
    if (!(toAge > fromAge) || !(maxLifeDays > 0))
        return 0;
    let total = 0;
    let start = 0;
    for (const stage of GROWTH_STAGES) {
        const end = stage.until * maxLifeDays;
        const overlap = Math.min(toAge, end) - Math.max(fromAge, start);
        if (overlap > 0)
            total += overlap * stage.weight * (fastGrower && stage.id === "youth" ? FAST_GROWER_YOUTH_BONUS : 1);
        start = end;
    }
    return total;
}
export function growthStage(ageDays, maxLifeDays) {
    return GROWTH_STAGES.find((stage) => ageDays < stage.until * maxLifeDays) ?? GROWTH_STAGES[GROWTH_STAGES.length - 1];
}
/** A Steady, un-jittered rate: the species range spread across its weighted growing life. */
export function baseGrowthRate(range, maxLifeDays) {
    const lifetime = growthStageDays(0, maxLifeDays, maxLifeDays, false);
    return lifetime > 0 ? Math.max(0, range.max - range.min) * GROWTH_BUDGET_SHARE / lifetime : 0;
}
/** The fastest rate any roll can produce; the trust bound for stored rates. */
export function maxGrowthRate(range, maxLifeDays) {
    return baseGrowthRate(range, maxLifeDays) * PET_GROWTH_GRADES[PET_GROWTH_GRADES.length - 1].multiplier * RATE_JITTER.max;
}
/** The most one stat could have gained by this age under perfect care. */
export function maxGainedByAge(rate, ageDays, maxLifeDays) {
    return rate * growthStageDays(0, ageDays, maxLifeDays, true) * MAX_CARE_MULTIPLIER;
}
function gainCeiling(base, paletteBonus) {
    return Math.max(0, STAT_CEILING / (1 + paletteBonus) - base);
}
/** Visible stats: base plus earned growth, with the palette bonus applied once, capped at 100. */
export function statsFromGrowth(growth, paletteBonus) {
    const stat = (id) => round(Math.min(STAT_CEILING, (growth.base[id] + growth.gained[id]) * (1 + paletteBonus)), 1);
    return Object.freeze({ speed: stat("speed"), strength: stat("strength") });
}
export function rollGrowthGrade(tier, random) {
    const weights = GROWTH_GRADE_WEIGHTS[tier] ?? GROWTH_GRADE_WEIGHTS.classic;
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let roll = unit(random()) * total;
    for (let index = 0; index < PET_GROWTH_GRADES.length; index += 1) {
        roll -= weights[index] ?? 0;
        if (roll < 0)
            return PET_GROWTH_GRADES[index];
    }
    return PET_GROWTH_GRADES[0];
}
/** Adoption-time roll. Consumes exactly three random values: grade, speed jitter, strength jitter. */
export function rollPetGrowth(species, base, tier, random) {
    const grade = rollGrowthGrade(tier, random);
    const rate = (id) => {
        const jitter = RATE_JITTER.min + (RATE_JITTER.max - RATE_JITTER.min) * unit(random());
        return round(baseGrowthRate(species.stats[id], species.maxLifeDays) * grade.multiplier * jitter, 5);
    };
    return Object.freeze({
        grade: grade.id,
        base: Object.freeze({ speed: round(base.speed, 5), strength: round(base.strength, 5) }),
        rates: Object.freeze({ speed: rate("speed"), strength: rate("strength") }),
        gained: Object.freeze({ speed: 0, strength: 0 }),
        rapport: RAPPORT_NEUTRAL,
        treatDay: 0,
        treats: EMPTY_TREATS,
    });
}
/** Bound stored growth against the species. `fallback` supplies anything missing or malformed. */
export function normalizePetGrowth(species, value, fallback, ageDays, paletteBonus) {
    const source = value && typeof value === "object" ? value : {};
    const pair = (raw) => raw && typeof raw === "object" ? raw : {};
    const baseIn = pair(source.base);
    const ratesIn = pair(source.rates);
    const gainedIn = pair(source.gained);
    const treatsIn = source.treats && typeof source.treats === "object" ? source.treats : {};
    const base = {};
    const rates = {};
    const gained = {};
    for (const id of STAT_IDS) {
        const range = species.stats[id];
        base[id] = round(bounded(baseIn[id], range.min, range.max, fallback.base[id]), 5);
        // Clamp after rounding so a value at its bound can never round past it.
        const maxRate = maxGrowthRate(range, species.maxLifeDays);
        rates[id] = Math.min(maxRate, round(bounded(ratesIn[id], 0, maxRate, fallback.rates[id]), 5));
        const cap = Math.min(gainCeiling(base[id], paletteBonus), maxGainedByAge(rates[id], ageDays, species.maxLifeDays));
        gained[id] = Math.min(cap, round(bounded(gainedIn[id], 0, cap, Math.min(cap, fallback.gained[id])), 4));
    }
    return Object.freeze({
        grade: PET_GROWTH_GRADES.some((grade) => grade.id === source.grade) ? source.grade : fallback.grade,
        base: Object.freeze(base),
        rates: Object.freeze(rates),
        gained: Object.freeze(gained),
        rapport: round(bounded(source.rapport, 0, 100, fallback.rapport), 4),
        treatDay: Math.floor(bounded(source.treatDay, 0, 1e7, fallback.treatDay)),
        treats: Object.freeze({
            pet: Math.floor(bounded(treatsIn.pet, 0, 99, 0)),
            carry: Math.floor(bounded(treatsIn.carry, 0, 99, 0)),
            play: Math.floor(bounded(treatsIn.play, 0, 99, 0)),
            feed: Math.floor(bounded(treatsIn.feed, 0, 99, 0)),
        }),
    });
}
/** A pet from before progression existed: credit the days it already lived at ordinary care. */
export function legacyPetGrowth(species, rolled, ageDays, fastGrower, paletteBonus) {
    const days = growthStageDays(0, ageDays, species.maxLifeDays, fastGrower);
    const gained = (id) => round(Math.min(gainCeiling(rolled.base[id], paletteBonus), rolled.rates[id] * days * LEGACY_CARE_MULTIPLIER), 4);
    return Object.freeze({ ...rolled, gained: Object.freeze({ speed: gained("speed"), strength: gained("strength") }) });
}
/** How strongly current care converts a growing day into stat points (0 – MAX_CARE_MULTIPLIER). */
export function careGrowthMultiplier(sample) {
    const hunger = clamp(Number.isFinite(sample.hungerWeight) ? sample.hungerWeight : 0, 0, 1);
    const happiness = clamp((sample.happiness - HAPPINESS_GROWTH_FLOOR) / (HAPPINESS_GROWTH_FULL - HAPPINESS_GROWTH_FLOOR), 0, 1);
    const affinity = AFFINITY_FACTOR.min + (AFFINITY_FACTOR.max - AFFINITY_FACTOR.min) * clamp(sample.affection, 0, 100) / 100;
    const rapport = RAPPORT_FACTOR.min + (RAPPORT_FACTOR.max - RAPPORT_FACTOR.min) * clamp(sample.rapport, 0, 100) / 100;
    return hunger * happiness * affinity * rapport;
}
function driftRapport(rapport, days) {
    const step = RAPPORT_DRIFT_PER_DAY * days;
    return rapport > RAPPORT_NEUTRAL ? Math.max(RAPPORT_NEUTRAL, rapport - step) : Math.min(RAPPORT_NEUTRAL, rapport + step);
}
/**
 * Advance one interval. Happiness, affection and rapport move linearly inside
 * a checkpoint, so their midpoint is the interval's average; the caller keeps
 * intervals at or under one farm day so a long absence is integrated in steps.
 */
export function advancePetGrowth(growth, interval) {
    if (!(interval.elapsedDays > 0))
        return growth;
    const rapport = driftRapport(growth.rapport, interval.elapsedDays);
    const days = growthStageDays(interval.fromAge, interval.toAge, interval.species.maxLifeDays, interval.fastGrower);
    const care = careGrowthMultiplier({
        hungerWeight: interval.hungerWeight,
        happiness: (interval.happiness[0] + interval.happiness[1]) / 2,
        affection: (interval.affection[0] + interval.affection[1]) / 2,
        rapport: (growth.rapport + rapport) / 2,
    });
    const gained = (id) => round(Math.min(gainCeiling(growth.base[id], interval.paletteBonus), growth.gained[id] + growth.rates[id] * days * care), 4);
    return Object.freeze({
        ...growth,
        rapport: round(rapport, 4),
        gained: Object.freeze({ speed: gained("speed"), strength: gained("strength") }),
    });
}
export const treatmentBucket = (kind) => kind === "feed-early" ? "feed" : kind;
/**
 * Apply one treatment. `delta` is the pet's full preference for this kind
 * (baseline + traits, computed by the care catalog). Repeats of one kind in a
 * farm day fade out, so rapport rewards daily attention rather than key-mashing.
 */
export function applyPetTreatment(growth, kind, delta, farmDay) {
    const day = Math.max(0, Math.floor(Number.isFinite(farmDay) ? farmDay : 0));
    const treats = day === growth.treatDay ? growth.treats : EMPTY_TREATS;
    const bucket = treatmentBucket(kind);
    const scale = DAILY_TREATMENT_SCALE[treats[bucket]] ?? 0;
    const applied = round(delta * scale, 4);
    return Object.freeze({
        applied,
        growth: Object.freeze({
            ...growth,
            rapport: round(clamp(growth.rapport + applied, 0, 100), 4),
            treatDay: day,
            treats: Object.freeze({ ...treats, [bucket]: Math.min(99, treats[bucket] + 1) }),
        }),
    });
}
/** Player-facing growth trend. It reflects hidden affection/rapport as a feeling, never as a number. */
export function petGrowthOutlook(growth, sample, ageDays, maxLifeDays, paletteBonus) {
    const capped = STAT_IDS.every((id) => growth.gained[id] >= gainCeiling(growth.base[id], paletteBonus) - 1e-6);
    if (capped || growthStage(ageDays, maxLifeDays).weight <= 0)
        return Object.freeze({ level: "peaked", label: "At peak" });
    const care = careGrowthMultiplier(sample);
    if (care >= 1.15)
        return Object.freeze({ level: "thriving", label: "Thriving" });
    if (care >= 0.75)
        return Object.freeze({ level: "growing", label: "Growing well" });
    if (care > 0.2)
        return Object.freeze({ level: "slow", label: "Growing slowly" });
    return Object.freeze({ level: "stalled", label: "Not growing" });
}
