// Riding a course run again (planning-docs/FARM_RIDING_PLAN.md). A finished
// run at Windrush Downs is sent to platform-api as the horse's state at the
// start line and one packed input byte per tick; the server rides it again here,
// on the same sim, from the horse's own numbers as the SERVER computes them,
// and pays Riding XP and training for what happened — never for what was
// claimed. Part of the riding set `tools/mirror-riding-sim.mjs` copies byte for
// byte. Pure.
import { rideGait, stepRide, unpackRideInput } from "./farm-ride.mjs";
import { crossesLine, findDownsCourse, FAULTS_PER_RAIL, MAX_RUN_TICKS } from "./downs-course.mjs";
import { DOWNS_WALKER_BOUNDS, downsJumps, downsSolids } from "./downs-scene.mjs";
import { downsGround, downsWaterDepth } from "./downs-terrain.mjs";
/** How far a claimed start may be from the course's start line, and how fast the horse may be going there. */
export const START_REACH = 6;
let worlds = null;
function worldFor(championship) {
    worlds ??= {
        standard: Object.freeze({ bounds: DOWNS_WALKER_BOUNDS, solids: downsSolids(), jumps: downsJumps(false), ground: downsGround, water: downsWaterDepth }),
        championship: Object.freeze({ bounds: DOWNS_WALKER_BOUNDS, solids: downsSolids(), jumps: downsJumps(true), ground: downsGround, water: downsWaterDepth }),
    };
    return (championship ? worlds.championship : worlds.standard);
}
/** A claimed start the server will ride from, or null when it could not have happened (off the line, faster than the horse, more wind than it has). */
export function plausibleStart(courseId, start, profile) {
    const course = findDownsCourse(courseId);
    if (!course)
        return null;
    const numbers = [start.x, start.z, start.y, start.vy, start.heading, start.speed, start.stamina, start.stumble];
    if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value)))
        return null;
    if (Math.hypot(start.x - course.start.x, start.z - course.start.z) > START_REACH + course.start.width / 2)
        return null;
    if (start.speed > profile.gallopSpeed + 1e-6 || start.speed < -profile.reverseSpeed - 1e-6)
        return null;
    if (start.stamina < 0 || start.stamina > profile.staminaMax + 1e-6)
        return null;
    if (start.stumble < 0 || start.stumble > profile.stumbleSeconds + 1e-6)
        return null;
    if (start.vy > Math.sqrt(2 * 22 * profile.jumpApex) + 1e-6)
        return null;
    return Object.freeze({
        x: start.x, z: start.z, y: start.y, vy: start.vy, heading: start.heading, speed: start.speed, stamina: start.stamina,
        winded: Boolean(start.winded), airborne: Boolean(start.airborne), stumble: start.stumble, jumpHeld: Boolean(start.jumpHeld),
        inside: Object.freeze([]), faulted: Object.freeze([]), tick: 0,
    });
}
/** Ride the run again, tick for tick, keeping the course as `stepCourse` does. */
export function replayRun(courseId, start, inputs, profile) {
    const course = findDownsCourse(courseId);
    const world = worldFor(courseId === "xc-championship");
    const fenceIds = new Set(course.steps.filter((step) => step.kind === "fence").map((step) => step.line.id));
    let state = start;
    let next = 0;
    let faults = 0;
    let gallopTicks = 0;
    let cleared = 0;
    const knocked = new Set();
    const limit = Math.min(inputs.length, MAX_RUN_TICKS);
    for (let index = 0; index < limit; index += 1) {
        const step = stepRide(state, unpackRideInput(inputs[index]), profile, world, 1 / 60, "piloted");
        for (const event of step.events) {
            if (event.kind === "fault" && event.id && fenceIds.has(event.id) && !knocked.has(event.id)) {
                knocked.add(event.id);
                faults += FAULTS_PER_RAIL;
            }
            if (event.kind === "cleared" && event.id && fenceIds.has(event.id) && !knocked.has(event.id))
                cleared += 1;
        }
        if (rideGait(step.state.speed, profile) === "gallop")
            gallopTicks += 1;
        const due = course.steps[next];
        if (due && crossesLine(due.line, state, step.state))
            next += 1;
        if (next >= course.steps.length && crossesLine(course.finish, state, step.state)) {
            return Object.freeze({ finished: true, ticks: index + 1, faults, gallopTicks, cleared });
        }
        state = step.state;
    }
    return Object.freeze({ finished: false, ticks: limit, faults, gallopTicks, cleared });
}
