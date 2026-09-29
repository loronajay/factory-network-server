// The horse's riding stats (planning-docs/FARM_RIDING_PLAN.md).
//
// A horse is a pet, so it has the pets' Speed and Strength, grown by the pets'
// growth pipeline (`farm-pet-growth.mts`). Riding needs two more — STAMINA
// (the size of its wind, how fast it gets it back) and AGILITY (how tight it
// turns at speed, how quickly it gathers itself after a stumble) — and a
// horse's profile carries them in a `riding` block beside `growth`.
//
// THE EXTRA TWO GROW IN STEP WITH THE FIRST TWO. The pets' pipeline already
// integrates every living day's care into `gained`; dividing a stat's gain by
// its rate gives the "effective growing days" the horse has had, and Stamina
// and Agility have grown by their own rate over those same days. So nothing
// new has to be simulated, and the server can recompute all four from pinned
// values (base and rates) plus the pets' own gains — the same trust standing.
//
// TRAINING is the one thing riding adds on top: `trained` points, earned only
// from rides the server verified, capped per farm day and never past what the
// horse's potential could have reached at plain perfect care. Training helps a
// horse reach its potential; it never raises it.
//
// Pure — no THREE, no DOM, no clock. Mirrored rule for rule by
// `platform-api/src/services/farm-horse-catalog.mts`; a parity test holds them.
import { baseGrowthRate, findGrowthGrade, growthStageDays, maxGrowthRate, RATE_JITTER, STAT_CEILING } from "./farm-pet-growth.mjs";
export const HORSE_SPECIES_ID = "pet.horse";
export const HORSE_LIFE_DAYS = 160;
export const RIDING_STAT_IDS = Object.freeze(["stamina", "agility"]);
export const HORSE_STAT_IDS = Object.freeze(["speed", "strength", "stamina", "agility"]);
/** Where a new horse's riding stats are rolled from (Speed and Strength live on its care row). */
export const HORSE_RIDING_RANGES = Object.freeze({
    stamina: Object.freeze({ min: 30, max: 65 }),
    agility: Object.freeze({ min: 28, max: 62 }),
});
export const HORSE_STAT_TITLES = Object.freeze({
    speed: "Speed", strength: "Strength", stamina: "Stamina", agility: "Agility",
});
export const HORSE_STAT_BLURBS = Object.freeze({
    speed: "Its top speed at the gallop.",
    strength: "How high it jumps and how hard it accelerates.",
    stamina: "How long it can gallop, and how fast it gets its wind back.",
    agility: "How tight it turns at speed, and how quickly it recovers from a stumble.",
});
/** Lifetime training ceiling per stat, before the potential cap. */
export const HORSE_TRAINING_CAP = 12;
/** Training points a horse can take in one farm day, all stats together. */
export const HORSE_TRAINING_PER_DAY = 1.5;
const ZERO_TRAINED = Object.freeze({ speed: 0, strength: 0, stamina: 0, agility: 0 });
const unit = (value) => Number.isFinite(value) ? Math.min(0.999999, Math.max(0, value)) : 0;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, places) => Number(value.toFixed(places));
const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
/**
 * Roll a horse's riding block. Consumes exactly four random values, in this
 * order: stamina base, agility base, stamina jitter, agility jitter. Called
 * after the pets' own roll, so every earlier draw is the pets' as before.
 */
export function rollHorseRiding(gradeId, random) {
    const grade = findGrowthGrade(gradeId);
    const base = (id) => {
        const range = HORSE_RIDING_RANGES[id];
        return round(range.min + (range.max - range.min) * unit(random()), 5);
    };
    const stamina = base("stamina");
    const agility = base("agility");
    const rate = (id) => round(baseGrowthRate(HORSE_RIDING_RANGES[id], HORSE_LIFE_DAYS) * grade.multiplier * (RATE_JITTER.min + (RATE_JITTER.max - RATE_JITTER.min) * unit(random())), 5);
    const rates = { stamina: rate("stamina"), agility: rate("agility") };
    return Object.freeze({
        base: Object.freeze({ stamina, agility }),
        rates: Object.freeze(rates),
        trained: ZERO_TRAINED,
        trainedDay: 0,
        trainedToday: 0,
    });
}
/** Shape and species bounds on a stored riding block; `fallback` fills anything missing. */
export function normalizeHorseRiding(value, fallback) {
    const source = value && typeof value === "object" ? value : {};
    const base = { stamina: 0, agility: 0 };
    const rates = { stamina: 0, agility: 0 };
    for (const id of RIDING_STAT_IDS) {
        const range = HORSE_RIDING_RANGES[id];
        base[id] = round(clamp(finite(source.base?.[id]) ?? fallback.base[id], range.min, range.max), 5);
        const maxRate = maxGrowthRate(range, HORSE_LIFE_DAYS);
        rates[id] = Math.min(maxRate, round(clamp(finite(source.rates?.[id]) ?? fallback.rates[id], 0, maxRate), 5));
    }
    const trained = {};
    for (const id of HORSE_STAT_IDS)
        trained[id] = round(clamp(finite(source.trained?.[id]) ?? 0, 0, HORSE_TRAINING_CAP), 4);
    return Object.freeze({
        base: Object.freeze(base),
        rates: Object.freeze(rates),
        trained: Object.freeze(trained),
        trainedDay: Math.floor(clamp(finite(source.trainedDay) ?? 0, 0, 1e7)),
        trainedToday: round(clamp(finite(source.trainedToday) ?? 0, 0, HORSE_TRAINING_PER_DAY), 4),
    });
}
/**
 * The growing days a horse has effectively had: the pets' pipeline gave Speed
 * and Strength `rate × days × care`, so gain ÷ rate is that product. The larger
 * of the two is taken, because a stat that has reached 100 stops gaining.
 */
export function effectiveGrowingDays(growth) {
    const days = (id) => growth.rates[id] > 0 ? growth.gained[id] / growth.rates[id] : 0;
    return Math.max(0, days("speed"), days("strength"));
}
/** The most a stat's rate could produce over a whole life at plain perfect care: the training ceiling. */
export function lifetimePotential(rate) {
    return rate * growthStageDays(0, HORSE_LIFE_DAYS, HORSE_LIFE_DAYS, false);
}
/** All four riding stats as the horse stands today: grown, trained, with its palette bonus once. 0–100. */
export function horseStats(profile) {
    const bonus = clamp(profile.paletteBonus, 0, 0.5);
    const riding = profile.riding;
    if (!riding)
        return Object.freeze({ speed: profile.stats.speed, strength: profile.stats.strength, stamina: 0, agility: 0 });
    const days = effectiveGrowingDays(profile.growth);
    const grown = (id) => {
        const ceiling = Math.max(0, STAT_CEILING / (1 + bonus) - riding.base[id]);
        return Math.min(ceiling, riding.rates[id] * days);
    };
    const finish = (value) => round(Math.min(STAT_CEILING, value * (1 + bonus)), 1);
    const trainedFor = (id, rate, gained) => Math.min(riding.trained[id], Math.max(0, lifetimePotential(rate) - gained));
    return Object.freeze({
        speed: round(Math.min(STAT_CEILING, profile.stats.speed + trainedFor("speed", profile.growth.rates.speed, profile.growth.gained.speed) * (1 + bonus)), 1),
        strength: round(Math.min(STAT_CEILING, profile.stats.strength + trainedFor("strength", profile.growth.rates.strength, profile.growth.gained.strength) * (1 + bonus)), 1),
        stamina: finish(riding.base.stamina + grown("stamina") + trainedFor("stamina", riding.rates.stamina, grown("stamina"))),
        agility: finish(riding.base.agility + grown("agility") + trainedFor("agility", riding.rates.agility, grown("agility"))),
    });
}
/**
 * Credit a verified ride's training. `gains` is what the ride asked for, per
 * stat; what is applied is capped by the day's allowance (shared by all four
 * stats, in the order given) and each stat's lifetime cap.
 */
export function trainHorse(riding, gains, farmDay) {
    const day = Math.max(0, Math.floor(Number.isFinite(farmDay) ? farmDay : 0));
    let left = HORSE_TRAINING_PER_DAY - (day === riding.trainedDay ? riding.trainedToday : 0);
    const trained = { ...riding.trained };
    const applied = { speed: 0, strength: 0, stamina: 0, agility: 0 };
    for (const id of HORSE_STAT_IDS) {
        const want = Math.max(0, finite(gains[id]) ?? 0);
        const take = Math.max(0, Math.min(want, left, HORSE_TRAINING_CAP - trained[id]));
        trained[id] = round(trained[id] + take, 4);
        applied[id] = round(take, 4);
        left -= take;
    }
    const used = HORSE_STAT_IDS.reduce((sum, id) => sum + applied[id], 0);
    return Object.freeze({
        applied: Object.freeze(applied),
        riding: Object.freeze({
            ...riding,
            trained: Object.freeze(trained),
            trainedDay: day,
            trainedToday: round((day === riding.trainedDay ? riding.trainedToday : 0) + used, 4),
        }),
    });
}
