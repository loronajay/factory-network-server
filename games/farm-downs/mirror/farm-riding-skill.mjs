// The Riding skill (planning-docs/FARM_RIDING_PLAN.md): the rider's side of
// riding. Server-owned like Farming — `skills.riding` on the farm document is
// raised only by rides the server verified (a Windrush Downs course run it
// replayed from the input log, a race the network server settled) — on the
// same 1–99 curve (`farm-skills.mts`).
//
// Its levels are PERKS to every horse the player rides. They are kept modest
// (all together about +15%) so the horse stays the main thing; the table is
// data so it can be tuned without touching the sim. Pure, and mirrored by
// `platform-api/src/services/farm-riding-catalog.mts` (the XP awards).
export const RIDING_PERKS = Object.freeze([
    { level: 1, id: "novice-ring", title: "Novice Ring", description: "Walk, trot, canter and gallop; the Novice Show Ring." },
    { level: 5, id: "steady-seat", title: "Steady Seat", description: "Stumbles last 25% shorter." },
    { level: 10, id: "open-ring", title: "Open Show Ring", description: "The Open course, and the gallop costs 5% less wind." },
    { level: 15, id: "light-hands", title: "Light Hands", description: "Turns 5% tighter at speed." },
    { level: 20, id: "exceptional-horses", title: "A Good Eye", description: "Hollis sells you Exceptional horses." },
    { level: 25, id: "second-wind", title: "Second Wind", description: "A winded horse is ready to gallop again at 20% instead of 30%." },
    { level: 30, id: "clean-jumper", title: "Clean Jumper", description: "Every fence is cleared with 8 cm to spare." },
    { level: 40, id: "long-wind", title: "Long Wind", description: "The gallop costs 10% less wind in all." },
    { level: 50, id: "collected-canter", title: "Collected Canter", description: "The canter costs no wind at all." },
    { level: 60, id: "prodigy-horses", title: "Horseman's Eye", description: "Hollis sells you Prodigy horses, and the Championship cross-country line opens." },
    { level: 75, id: "flying-change", title: "Flying Change", description: "3% more at the gallop." },
    { level: 99, id: "master-rider", title: "Master Rider", description: "The mastery of the Downs." },
].map((perk) => Object.freeze(perk)));
/** What a Riding level does to every horse (multipliers are 1 and flags false below the level). */
export function ridingPerkEffects(level) {
    const at = (needed) => level >= needed;
    return Object.freeze({
        stumble: at(5) ? 0.75 : 1,
        gallopDrain: at(40) ? 0.9 : at(10) ? 0.95 : 1,
        turnFast: at(15) ? 1.05 : 1,
        windedRecover: at(25) ? 0.2 : 0.3,
        clearanceBonus: at(30) ? 0.08 : 0,
        canterFree: at(50),
        gallopSpeed: at(75) ? 1.03 : 1,
        openRing: at(10),
        championship: at(60),
    });
}
// ---------------------------------------------------------------- what riding pays
/** A course run's base XP, before its faults and the day's repeats. */
export const RUN_XP = Object.freeze({
    gallop: 40, novice: 60, open: 110, xc: 150, "xc-championship": 240, "oval-1": 60, "oval-2": 110,
});
/** Each run of one course in a UTC day pays less than the one before: 1, ¾, 0.6, ½ … never under a fifth. */
export function repeatFactor(runsBefore) {
    return Math.max(0.2, 1 / (1 + 0.35 * Math.max(0, Math.floor(runsBefore))));
}
/** A clear round pays a quarter more; every four faults costs a tenth, down to half. */
export function faultFactor(faults) {
    return faults <= 0 ? 1.25 : Math.max(0.5, 1 - 0.1 * (faults / 4));
}
/** A run ridden in more than three times the course's par was a hack round, not a run: half pay. */
export function paceFactor(ticks, par) {
    return ticks > par * 60 * 3 ? 0.5 : 1;
}
export function runXp(courseId, faults, ticks, par, runsBefore) {
    const base = RUN_XP[courseId] ?? 0;
    return Math.round(base * faultFactor(faults) * paceFactor(ticks, par) * repeatFactor(runsBefore));
}
/** A race's XP: for finishing, more for the placing, and more for a bigger field. A DNF earns nothing. */
export function raceXp(place, field) {
    if (!(place >= 1))
        return 0;
    const bonus = place === 1 ? 120 : place === 2 ? 60 : place === 3 ? 30 : 0;
    return Math.round((80 + bonus) * (1 + 0.15 * Math.max(0, field - 2)));
}
/** What a verified ride trained, per stat, before the day's allowance: galloping builds Speed and Stamina, clean fences Strength and Agility. */
export function trainingFrom(gallopTicks, cleared) {
    const gallopSeconds = Math.max(0, gallopTicks) / 60;
    const fences = Math.max(0, cleared);
    return Object.freeze({
        speed: Number((gallopSeconds * 0.01).toFixed(4)),
        stamina: Number((gallopSeconds * 0.012).toFixed(4)),
        strength: Number((fences * 0.05).toFixed(4)),
        agility: Number((fences * 0.05).toFixed(4)),
    });
}
/** The perks a level has, and the next one to come. */
export function ridingPerksAt(level) {
    return Object.freeze({
        owned: Object.freeze(RIDING_PERKS.filter((perk) => perk.level <= level)),
        next: RIDING_PERKS.find((perk) => perk.level > level) ?? null,
    });
}
