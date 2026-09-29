// A horse's riding numbers (planning-docs/FARM_RIDING_PLAN.md): its four
// stats, how it is kept, its traits and the rider's Riding perks in, the
// `RideProfile` the piloted sim runs on out.
//
//   Gallop top speed   9 + 6·Speed           9–15 m/s
//   Acceleration       2.5 + 2·Strength + Speed   2.5–5.5 m/s²
//   Wind               60 + 60·Stamina       60–120
//   Turn at the gallop 50° + 50°·Agility /s  (140°/s at a walk)
//   Jump apex          0.7 + 0.9·Strength    0.7–1.6 m
//   (each stat as a share of 100)
//
// CONDITION MATTERS ON THE TRACK: a hungry horse has less wind (and a starving
// one will not gallop), an unhappy one gets its wind back slower, and an old
// one has lost a little of its top speed. Traits add their own as data
// (`RIDE_TRAIT_EFFECTS`, keyed by the pets' trait ids). Pure, with no imports
// outside the riding set, so platform-api (replaying a run) and the network
// server's race room run on exactly these numbers.
import { COSMETIC_PROFILE } from "./farm-ride.mjs";
import { ridingPerkEffects } from "./farm-riding-skill.mjs";
export const NEUTRAL_RIDE_TRAITS = Object.freeze({ rideAccel: 1, rideStamina: 1, rideRecovery: 1, rideTurn: 1, rideJump: 1 });
/** What a pet trait (`farm-pet-care.mts` ids) does to a horse under a rider. A trait not named here does nothing to riding. */
export const RIDE_TRAIT_EFFECTS = Object.freeze({
    "movement.fast": Object.freeze({ rideAccel: 1.12 }),
    "movement.lazy": Object.freeze({ rideRecovery: 0.85 }),
    "body.hardy": Object.freeze({ rideStamina: 1.1 }),
    "movement.roams": Object.freeze({ rideStamina: 1.05 }),
    "temper.grumpy": Object.freeze({ rideTurn: 0.95 }),
    "play.eager": Object.freeze({ rideJump: 1.05 }),
});
/** A horse's traits' riding effects, multiplied together. */
export function rideTraitsFor(traits) {
    const product = (key) => traits.reduce((total, id) => total * (RIDE_TRAIT_EFFECTS[id]?.[key] ?? 1), 1);
    return Object.freeze({ rideAccel: product("rideAccel"), rideStamina: product("rideStamina"), rideRecovery: product("rideRecovery"), rideTurn: product("rideTurn"), rideJump: product("rideJump") });
}
export const HUNGRY_BELOW = 30;
export const STARVING_BELOW = 10;
export const UNHAPPY_BELOW = 40;
const DEGREES = Math.PI / 180;
const share = (value) => Math.min(1, Math.max(0, (Number.isFinite(value) ? value : 0) / 100));
const round = (value) => Number(value.toFixed(4));
export function rideProfile(stats, condition, traits = NEUTRAL_RIDE_TRAITS, ridingLevel = 1) {
    const perks = ridingPerkEffects(ridingLevel);
    const speed = share(stats.speed);
    const strength = share(stats.strength);
    const stamina = share(stats.stamina);
    const agility = share(stats.agility);
    const hungry = condition.hunger < HUNGRY_BELOW;
    const recovery = (condition.happiness < UNHAPPY_BELOW ? 0.8 : 1) * traits.rideRecovery;
    const gallopDrain = -10 * perks.gallopDrain;
    return Object.freeze({
        walkSpeed: 1.8,
        trotSpeed: 4,
        canterSpeed: 7,
        gallopSpeed: round((9 + 6 * speed) * (condition.elder ? 0.9 : 1) * perks.gallopSpeed),
        accel: round((2.5 + 2 * strength + speed) * traits.rideAccel),
        brake: 9,
        coast: 2.2,
        reverseSpeed: 1,
        turnSlow: round(140 * DEGREES),
        turnFast: round((50 + 50 * agility) * DEGREES * perks.turnFast * traits.rideTurn),
        staminaMax: round((60 + 60 * stamina) * (hungry ? 0.7 : 1) * traits.rideStamina),
        drain: Object.freeze({
            gallop: round(gallopDrain),
            canter: perks.canterFree ? 0 : -1,
            trot: round(5 * recovery),
            walk: round(9 * recovery),
            idle: round(14 * recovery),
        }),
        jumpCost: 12,
        jumpApex: round((0.7 + 0.9 * strength) * traits.rideJump),
        clearanceBonus: perks.clearanceBonus,
        stumbleSeconds: round(0.9 * (1 - 0.5 * agility) * perks.stumble),
        windedRecover: perks.windedRecover,
        canGallop: condition.hunger >= STARVING_BELOW,
    });
}
/** Everywhere but the Downs: the rider's own pace, whatever the horse. */
export function cosmeticRideProfile() {
    return COSMETIC_PROFILE;
}
