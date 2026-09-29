// A race at Windrush Downs (planning-docs/FARM_RIDING_PLAN.md), as one pure
// function of its entrants and their reins.
//
// The network server runs this — `stepRace` sixty times a second on the
// entrants' inputs — and its finish order settles the stakes and the bets, so
// nobody's clock decides a race. Each racer's own page runs the same sim for
// its own horse to feel immediate (the horses never touch one another, so a
// racer's horse depends on nothing but its own reins and the course, and the
// prediction is exact). It is part of the riding set `tools/mirror-riding-sim.mjs`
// copies byte for byte.
//
// A race is: the horses lined up behind the start, held through a countdown,
// then ridden on the PILOTED sim over the Downs' own ground and fences; each
// passes the course's steps in order and is timed across the finish. Riders
// who have not finished `FINISH_WINDOW_TICKS` after the winner, or by the
// course's time limit, did not finish. Pure — no clock, no random.
import { createRideState, stepRide } from "./farm-ride.mjs";
import { forwardOf } from "./farm-ride-geometry.mjs";
import { crossesLine, findDownsCourse } from "./downs-course.mjs";
import { DOWNS_WALKER_BOUNDS, downsJumps, downsSolids } from "./downs-scene.mjs";
import { downsGround, downsWaterDepth } from "./downs-terrain.mjs";
export const RACE_COURSES = Object.freeze(["gallop", "oval-1", "oval-2", "xc"]);
export const COUNTDOWN_TICKS = 180;
/** How long after the winner the rest have to finish. */
export const FINISH_WINDOW_TICKS = 60 * 30;
export const MAX_RIDERS = 6;
let worldCache = null;
function buildWorld() {
    return Object.freeze({ bounds: DOWNS_WALKER_BOUNDS, solids: downsSolids(), jumps: downsJumps(false), ground: downsGround, water: downsWaterDepth });
}
/** The Downs as a race sees it: the standard cross-country line. */
export function raceWorld() {
    worldCache ??= buildWorld();
    return worldCache;
}
/** The ticks a race may run before everyone left out is a DNF: three times the course's par, and the countdown. */
export function raceTimeLimit(course) {
    return COUNTDOWN_TICKS + course.par * 60 * 3;
}
/** Where the `index`th of `count` horses stands at the start: in a line behind the start, across its width. */
export function startSlot(course, index, count) {
    const line = course.start;
    const forward = forwardOf(line.heading);
    const across = { x: -forward.z, z: forward.x };
    const spacing = Math.min(2.2, (line.width - 2) / Math.max(1, count - 1));
    const offset = (index - (count - 1) / 2) * spacing;
    return { x: line.x - forward.x * 3 + across.x * offset, z: line.z - forward.z * 3 + across.z * offset, heading: line.heading };
}
export function createRace(courseId, entrants) {
    const course = findDownsCourse(courseId);
    return Object.freeze({
        courseId,
        tick: 0,
        phase: "countdown",
        firstFinish: -1,
        riders: Object.freeze(entrants.map((entrant, index) => {
            const slot = startSlot(course, index, entrants.length);
            return Object.freeze({ playerId: entrant.playerId, ride: createRideState({ ...slot, y: downsGround(slot) }, entrant.profile), next: -1, faults: 0, finishTick: -1, dnf: false });
        })),
    });
}
const HOLD = Object.freeze({ urge: false, gallop: false, brake: false, left: false, right: false, jump: false });
/** One rider through one tick (exported so a racer's page predicts its own horse on exactly this). */
export function stepRaceRider(rider, input, profile, course, tick) {
    if (rider.finishTick >= 0 || rider.dnf)
        return rider;
    const held = tick < COUNTDOWN_TICKS;
    const step = stepRide(rider.ride, held ? HOLD : input, profile, raceWorld(), 1 / 60, "piloted");
    const after = step.state;
    let { next, faults, finishTick } = rider;
    // The start line counts as the first step: the clock runs from the countdown, but the course is from the line.
    if (next < 0) {
        if (crossesLine(course.start, rider.ride, after))
            next = 0;
    }
    else {
        const due = course.steps[next];
        if (due && crossesLine(due.line, rider.ride, after))
            next += 1;
        else if (!due && crossesLine(course.finish, rider.ride, after))
            finishTick = tick;
        const fenceIds = new Set(course.steps.filter((entry) => entry.kind === "fence").map((entry) => entry.line.id));
        for (const event of step.events)
            if (event.kind === "fault" && event.id && fenceIds.has(event.id))
                faults += 4;
    }
    return Object.freeze({ ...rider, ride: after, next, faults, finishTick });
}
/** One tick of the race. `inputs` is each rider's reins by player id (a missing rider holds still). */
export function stepRace(race, inputs, profiles) {
    if (race.phase === "finished")
        return race;
    const course = findDownsCourse(race.courseId);
    const tick = race.tick;
    let firstFinish = race.firstFinish;
    const riders = race.riders.map((rider) => {
        const profile = profiles.get(rider.playerId);
        if (!profile)
            return rider;
        const next = stepRaceRider(rider, inputs.get(rider.playerId) ?? HOLD, profile, course, tick);
        if (next.finishTick >= 0 && firstFinish < 0)
            firstFinish = next.finishTick;
        return next;
    });
    const limit = raceTimeLimit(course);
    const cutoff = firstFinish >= 0 ? firstFinish + FINISH_WINDOW_TICKS : limit;
    const over = tick + 1 >= Math.min(limit, cutoff);
    const settled = riders.map((rider) => (over && rider.finishTick < 0 && !rider.dnf ? Object.freeze({ ...rider, dnf: true }) : rider));
    const done = settled.every((rider) => rider.finishTick >= 0 || rider.dnf);
    return Object.freeze({
        courseId: race.courseId,
        tick: tick + 1,
        riders: Object.freeze(settled),
        phase: done ? "finished" : tick + 1 >= COUNTDOWN_TICKS ? "running" : "countdown",
        firstFinish,
    });
}
/** The finish order: finishers by the tick they crossed (the cross-country adds a second a fault), then the rest. */
export function raceResult(race) {
    const course = findDownsCourse(race.courseId);
    const penalty = (rider) => (course.kind === "cross-country" ? rider.faults * 15 : 0);
    const finishers = race.riders.filter((rider) => rider.finishTick >= 0)
        .slice()
        .sort((a, b) => (a.finishTick + penalty(a)) - (b.finishTick + penalty(b)) || a.playerId.localeCompare(b.playerId));
    const finishTicks = {};
    for (const rider of finishers)
        finishTicks[rider.playerId] = rider.finishTick - COUNTDOWN_TICKS + penalty(rider);
    return Object.freeze({
        order: Object.freeze(finishers.map((rider) => rider.playerId)),
        finishTicks: Object.freeze(finishTicks),
        dnf: Object.freeze(race.riders.filter((rider) => rider.finishTick < 0).map((rider) => rider.playerId)),
    });
}
