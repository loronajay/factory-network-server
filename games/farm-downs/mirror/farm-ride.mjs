// Riding a horse (planning-docs/FARM_RIDING_PLAN.md): keys, a fixed timestep
// and the world in, the next pose out.
//
// ONE SIM, TWO MODES. Everywhere but Windrush Downs riding is COSMETIC: the
// horse goes at the rider's own walk and run, turns on A/D, and has no wind to
// lose and no jump. At the Downs it is PILOTED: the horse's own riding profile
// (`farm-ride-profile.mts`, from its stats, its condition and the rider's
// Riding perks) sets how hard it accelerates, how fast it gallops, how wide it
// turns at speed, how long its wind lasts and how high it jumps — and it has
// momentum: let go of W and it eases down, it does not stop dead.
//
// A horse is a long body, so it collides as two circles, its middle and its
// chest. Running into something solid at a canter or faster is a STUMBLE (the
// speed gone, some wind lost, the reins dead for a moment); slower, it just
// stops. A jump (`RideJump`) is passable — it is poles, not a wall — and asks
// for a height: go over it lower than its clearance and a rail comes down (a
// FAULT); go through it on the ground and that is a fault and a stumble.
//
// Pure and deterministic — no THREE, no DOM, no clock, no random — so a race
// can be run by the network server on the same inputs and land on the same
// horse (a byte-for-byte mirror, as Pet Games does), and a course run can be
// replayed from its input log by the API.
import { forwardOf, insideBox } from "./farm-ride-geometry.mjs";
export const NO_INPUT = Object.freeze({ urge: false, gallop: false, brake: false, left: false, right: false, jump: false });
export const RIDE_GRAVITY = 22;
/** A collision at this speed or faster is a stumble. */
export const STUMBLE_SPEED = 5.5;
/** The two circles a horse collides as: its middle, and its chest this far ahead. */
export const HORSE_BODY_RADIUS = 0.5;
export const HORSE_CHEST_OFFSET = 0.75;
/** Water deeper than this stops a horse; shallower than it but over `WADE_WATER` slows it. */
export const DEEP_WATER = 1.1;
export const WADE_WATER = 0.3;
export const WADE_SPEED_SHARE = 0.55;
/** A fence taken with the hooves this low was run through, not jumped. */
export const RAN_THROUGH_HEIGHT = 0.12;
export const RUN_THROUGH_SLOWDOWN = 0.3;
export const KNOCK_SLOWDOWN = 0.85;
/** Riding outside the Downs: the rider's own walk and run, no wind, no jump. */
export const COSMETIC_PROFILE = Object.freeze({
    walkSpeed: 2.65,
    trotSpeed: 4.3,
    canterSpeed: 4.3,
    gallopSpeed: 4.3,
    accel: 6,
    brake: 9,
    coast: 6,
    reverseSpeed: 1,
    turnSlow: 2.2,
    turnFast: 1.8,
    staminaMax: 1,
    drain: Object.freeze({ gallop: 0, canter: 0, trot: 0, walk: 0, idle: 0 }),
    jumpCost: 0,
    jumpApex: 0,
    clearanceBonus: 0,
    stumbleSeconds: 0,
    windedRecover: 0,
    canGallop: true,
});
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export function createRideState(pose, profile) {
    return Object.freeze({
        x: pose.x, z: pose.z, y: pose.y ?? 0, vy: 0, heading: pose.heading, speed: 0,
        stamina: profile.staminaMax, winded: false, airborne: false, stumble: 0, jumpHeld: false,
        inside: Object.freeze([]), faulted: Object.freeze([]), tick: 0,
    });
}
/** The gait a speed reads as, for the clip and the stamina. */
export function rideGait(speed, profile) {
    const pace = Math.abs(speed);
    if (pace < 0.15)
        return "idle";
    if (pace <= profile.walkSpeed + 0.3)
        return "walk";
    if (pace <= profile.trotSpeed + 0.5)
        return "trot";
    if (pace <= profile.canterSpeed + 0.5)
        return "canter";
    return "gallop";
}
/** True when a horse whose middle is at `point`, facing `heading`, would stand in something solid, deep water, or off the ground. */
export function rideBlocked(point, heading, world) {
    const forward = forwardOf(heading);
    const chest = { x: point.x + forward.x * HORSE_CHEST_OFFSET, z: point.z + forward.z * HORSE_CHEST_OFFSET };
    const { halfWidth, halfDepth, margin } = world.bounds;
    // The field's edge holds the horse's middle; its chest may reach out through an open gateway (the walls are solids).
    if (Math.abs(point.x) > halfWidth - margin || Math.abs(point.z) > halfDepth - margin)
        return true;
    for (const probe of [point, chest]) {
        if ((world.water?.(probe) ?? 0) > DEEP_WATER)
            return true;
        if (world.solids.some((solid) => insideBox(probe, solid, HORSE_BODY_RADIUS)))
            return true;
    }
    return false;
}
function jumpContains(jump, point) {
    return insideBox(point, { x: jump.x, z: jump.z, rotationY: jump.rotationY, footprint: { width: jump.width, depth: jump.depth } }, 0);
}
/** One fixed-timestep step of a ridden horse. */
export function stepRide(state, input, profile, world, dt, mode) {
    const events = [];
    const piloted = mode === "piloted";
    const ground = (point) => world.ground?.(point) ?? 0;
    const wading = (world.water?.(state) ?? 0) > WADE_WATER;
    let { speed, stamina, winded, stumble, heading, y, vy, airborne } = state;
    // ---- the reins
    if (stumble > 0) {
        stumble = Math.max(0, stumble - dt);
        speed = speed > 0 ? Math.max(0, speed - profile.brake * 1.5 * dt) : Math.min(0, speed + profile.brake * dt);
    }
    else if (!airborne) {
        const mayGallop = piloted ? profile.canGallop && !winded && stamina > 0 : true;
        let cap = input.gallop && mayGallop ? profile.gallopSpeed : piloted ? profile.canterSpeed : profile.walkSpeed;
        if (piloted && winded)
            cap = Math.min(cap, profile.trotSpeed);
        if (wading)
            cap = Math.min(cap, profile.trotSpeed * WADE_SPEED_SHARE);
        if (input.brake) {
            if (speed > 0.05)
                speed = Math.max(0, speed - profile.brake * dt);
            else
                speed = Math.max(-profile.reverseSpeed, speed - profile.accel * 0.5 * dt);
        }
        else if (input.urge) {
            if (speed < 0)
                speed = Math.min(0, speed + profile.brake * dt);
            else if (speed < cap)
                speed = Math.min(cap, speed + profile.accel * (1 - 0.5 * speed / Math.max(1, profile.gallopSpeed)) * dt);
            else
                speed = Math.max(cap, speed - profile.coast * 1.5 * dt);
        }
        else if (speed > 0) {
            speed = Math.max(0, speed - profile.coast * dt);
        }
        else if (speed < 0) {
            speed = Math.min(0, speed + profile.accel * dt);
        }
        // Turning: tight at a walk, wide at the gallop; a little on the spot.
        const span = Math.max(0.01, profile.gallopSpeed - profile.walkSpeed);
        const share = clamp((Math.abs(speed) - profile.walkSpeed) / span, 0, 1);
        const rate = Math.abs(speed) < 0.05 ? profile.turnSlow * 0.4 : profile.turnSlow + (profile.turnFast - profile.turnSlow) * share;
        const turn = (input.left ? 1 : 0) - (input.right ? 1 : 0);
        heading += turn * rate * dt * (speed < -0.05 ? -1 : 1);
    }
    // ---- the jump (a fresh press, on the ground, with the wind for it)
    const pressed = input.jump && !state.jumpHeld;
    if (piloted && pressed && !airborne && stumble === 0 && !winded && stamina >= profile.jumpCost && profile.jumpApex > 0) {
        vy = Math.sqrt(2 * RIDE_GRAVITY * profile.jumpApex);
        airborne = true;
        stamina -= profile.jumpCost;
        events.push({ kind: "jump" });
    }
    // ---- moving
    const forward = forwardOf(heading);
    let x = state.x;
    let z = state.z;
    if (Math.abs(speed) > 1e-6) {
        const next = { x: x + forward.x * speed * dt, z: z + forward.z * speed * dt };
        if (!rideBlocked(next, heading, world)) {
            x = next.x;
            z = next.z;
        }
        else {
            // Slide along whatever was hit, one axis at a time, before giving up.
            const alongX = { x: next.x, z };
            const alongZ = { x, z: next.z };
            const slid = !rideBlocked(alongX, heading, world) ? alongX : !rideBlocked(alongZ, heading, world) ? alongZ : null;
            const hard = Math.abs(speed) >= STUMBLE_SPEED;
            if (slid && !hard) {
                x = slid.x;
                z = slid.z;
                speed *= 0.8;
            }
            else {
                if (piloted && hard) {
                    stumble = profile.stumbleSeconds;
                    stamina = Math.max(0, stamina - 10);
                    events.push({ kind: "stumble" });
                }
                speed = 0;
            }
        }
    }
    // ---- up and down
    const floor = ground({ x, z });
    if (airborne) {
        vy -= RIDE_GRAVITY * dt;
        y += vy * dt;
        if (y <= floor) {
            y = floor;
            vy = 0;
            airborne = false;
            events.push({ kind: "land" });
        }
    }
    else {
        y = floor;
        vy = 0;
    }
    // ---- fences
    let inside = state.inside;
    let faulted = state.faulted;
    const jumps = world.jumps ?? [];
    if (jumps.length) {
        const now = [];
        const nextFaulted = [];
        for (const jump of jumps) {
            if (!jumpContains(jump, { x, z }))
                continue;
            now.push(jump.id);
            const already = faulted.includes(jump.id);
            if (already) {
                nextFaulted.push(jump.id);
                continue;
            }
            const height = y - floor + profile.clearanceBonus;
            if (!airborne && y - floor < RAN_THROUGH_HEIGHT && Math.abs(speed) > 0.5) {
                events.push({ kind: "fault", id: jump.id });
                nextFaulted.push(jump.id);
                speed *= RUN_THROUGH_SLOWDOWN;
                if (piloted) {
                    stumble = profile.stumbleSeconds;
                    events.push({ kind: "stumble", id: jump.id });
                }
            }
            else if (height < jump.clearance) {
                events.push({ kind: "fault", id: jump.id });
                nextFaulted.push(jump.id);
                speed *= KNOCK_SLOWDOWN;
            }
        }
        for (const id of inside)
            if (!now.includes(id))
                events.push({ kind: "cleared", id });
        inside = Object.freeze(now);
        faulted = Object.freeze(nextFaulted);
    }
    // ---- wind
    if (piloted) {
        const gait = rideGait(speed, profile);
        const rate = airborne ? 0 : profile.drain[gait];
        stamina = clamp(stamina + rate * dt, 0, profile.staminaMax);
        if (!winded && stamina <= 0) {
            winded = true;
            events.push({ kind: "winded" });
        }
        else if (winded && stamina >= profile.staminaMax * profile.windedRecover) {
            winded = false;
            events.push({ kind: "recovered" });
        }
    }
    return Object.freeze({
        state: Object.freeze({ x, z, y, vy, heading, speed, stamina, winded, airborne, stumble, jumpHeld: input.jump, inside, faulted, tick: state.tick + 1 }),
        events: Object.freeze(events),
    });
}
/**
 * Where a rider reaches from: the horse's head, `reach` ahead of its middle,
 * facing where it faces. A gate or a door is worked from here, because the
 * horse's chest meets a shut gate a long way before the rider's hands would.
 */
export function riderReach(state, reach = 1.1) {
    const forward = forwardOf(state.heading);
    return Object.freeze({ x: state.x + forward.x * reach, z: state.z + forward.z * reach, y: state.y, yaw: state.heading, forward });
}
/** Keys held → a ride input (W/S/A/D or the arrows, Shift, Space). */
export function rideInputFromKeys(keys) {
    return Object.freeze({
        urge: keys.has("KeyW") || keys.has("ArrowUp"),
        gallop: keys.has("ShiftLeft") || keys.has("ShiftRight"),
        brake: keys.has("KeyS") || keys.has("ArrowDown"),
        left: keys.has("KeyA") || keys.has("ArrowLeft"),
        right: keys.has("KeyD") || keys.has("ArrowRight"),
        jump: keys.has("Space"),
    });
}
/** An input as one byte (a course run's log and a race's input frame): bit per control. */
export function packRideInput(input) {
    return (input.urge ? 1 : 0) | (input.gallop ? 2 : 0) | (input.brake ? 4 : 0) | (input.left ? 8 : 0) | (input.right ? 16 : 0) | (input.jump ? 32 : 0);
}
export function unpackRideInput(byte) {
    const bits = Math.floor(Number(byte)) & 63;
    return Object.freeze({ urge: Boolean(bits & 1), gallop: Boolean(bits & 2), brake: Boolean(bits & 4), left: Boolean(bits & 8), right: Boolean(bits & 16), jump: Boolean(bits & 32) });
}
/** How fast a gait's clip plays for a speed, so the hooves keep up with the ground. */
export function rideClipRate(speed, gait) {
    const pace = Math.abs(speed);
    const base = gait === "walk" ? 1.3 : gait === "trot" ? 3 : gait === "canter" ? 6 : gait === "gallop" ? 8.5 : 1;
    return gait === "idle" ? 1 : clamp(pace / base, 0.6, 1.8);
}
/** The body clip a gait plays (the horse model's walk, trot and run; canter and gallop share the run). */
export function rideClip(gait, airborne) {
    if (airborne)
        return "jump";
    return gait === "idle" ? "idle" : gait === "walk" ? "walk" : gait === "trot" ? "trot" : "run";
}
