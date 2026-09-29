// Windrush Downs, as data (planning-docs/FARM_RIDING_PLAN.md). PURE — no
// THREE, no DOM.
//
// Everything that stands at the Downs is described here once — the Hitching
// Green's gate, trough and board; the gallop strip's start and finish; the
// two show rings and their fences; the oval's rails and its stand, betting
// booth and race board; the cross-country trail and its fences; the trees —
// and both the renderer (`downs-props.mts`) and the ride sim read that one
// description, so a rail is exactly where it stops a horse and a fence is
// exactly the height it asks for.
//
// x runs east, z south, y up; the Market Square's west gate is off the east
// edge. The ground's height is `downs-terrain.mts`.
import { DOWNS_BOUNDS, DOWNS_EARTHWORKS, DOWNS_HALF_DEPTH, DOWNS_HALF_WIDTH, DOWNS_ZONES, downsGround } from "./downs-terrain.mjs";
export { DOWNS_BOUNDS } from "./downs-terrain.mjs";
/** Everyone at the Downs shares one presence room on the arcade-room bridge. */
export const DOWNS_PRESENCE_ROOM = "farm:downs";
/** The gate in the east fence, back to the Market Square. */
export const DOWNS_GATE = Object.freeze({ x: DOWNS_HALF_WIDTH - 1, z: 0, width: 5 });
/** Just inside the gate, looking west across the Downs. */
export const DOWNS_SPAWN = Object.freeze({ x: DOWNS_HALF_WIDTH - 6, z: 0, yaw: Math.PI / 2 });
/** How far into the gateway a rider must be to be on their way back to the square. */
export const DOWNS_GATE_DEPTH = 2.2;
const point = (x, z) => Object.freeze({ x, z });
const line = (id, x, z, heading, width) => Object.freeze({ id, x, z, heading, width });
/** Headings, the walker's convention: 0 looks north (−z). */
export const WEST = Math.PI / 2;
export const EAST = -Math.PI / 2;
export const NORTH = 0;
export const SOUTH = Math.PI;
/** The box a fence occupies, facing its heading. */
export function fenceBox(fence) {
    return Object.freeze({ x: fence.x, z: fence.z, rotationY: fence.heading, footprint: Object.freeze({ width: fence.width, depth: fence.depth }) });
}
function fence(id, kind, x, z, heading, number, clearance, width = 3.6, depth) {
    const alongDepth = depth ?? (kind === "oxer" ? 1.4 : kind === "hedge" || kind === "brush" ? 1.1 : kind === "wall" ? 0.7 : kind === "log" ? 0.8 : kind === "ditch" ? 2.4 : 0.6);
    return Object.freeze({ id, kind, x, z, heading, width, depth: alongDepth, clearance, number });
}
export const DOWNS_RINGS = Object.freeze([
    Object.freeze({ id: "novice", title: "Novice Ring", zone: DOWNS_ZONES.novice, gate: point(27, -20) }),
    Object.freeze({ id: "open", title: "Open Ring", zone: DOWNS_ZONES.open, gate: point(59, -20) }),
]);
/** A ring's rail height, and how wide the entrance in its south side is. */
export const RING_RAIL_HEIGHT = 1.25;
export const RING_GATE_WIDTH = 6;
/** Fences inside a ring: a figure-of-eight the courses number. Heights are the course's. */
function ringFences(prefix, cx, height) {
    const low = height;
    return [
        fence(`${prefix}-1`, "vertical", cx - 5, -26, NORTH, 1, low),
        fence(`${prefix}-2`, "oxer", cx - 5, -40, NORTH, 2, low + 0.05, 3.6),
        fence(`${prefix}-3`, "wall", cx, -44, EAST, 3, low),
        fence(`${prefix}-4`, "vertical", cx + 5, -38, SOUTH, 4, low + 0.05),
        fence(`${prefix}-5`, "oxer", cx + 5, -28, SOUTH, 5, low),
        fence(`${prefix}-6`, "vertical", cx, -33, WEST, 6, low + 0.1),
    ];
}
export const NOVICE_FENCES = Object.freeze(ringFences("novice", 27, 0.8));
export const OPEN_FENCES = Object.freeze(ringFences("open", 59, 1.3));
// ---------------------------------------------------------------- the gallop
export const GALLOP_START = line("gallop-start", 84, -67, WEST, 14);
export const GALLOP_FINISH = line("gallop-finish", -88, -67, WEST, 14);
// ---------------------------------------------------------------- the oval
/** The oval: two straights along x joined by half circles. The track runs between the rails. */
export const OVAL = Object.freeze({ cx: -10, cz: 40, halfStraight: 35, radius: 22, trackWidth: 10 });
export const OVAL_INNER = OVAL.radius - OVAL.trackWidth / 2;
export const OVAL_OUTER = OVAL.radius + OVAL.trackWidth / 2;
/** The finish line on the north straight (by the stand); a lap is run clockwise, east along the north straight. */
export const OVAL_FINISH = line("oval-finish", OVAL.cx, OVAL.cz - OVAL.radius, EAST, OVAL.trackWidth + 1);
/** The quarter points a lap must pass through, in order after the finish. */
export const OVAL_CHECKPOINTS = Object.freeze([
    line("oval-east", OVAL.cx + OVAL.halfStraight + OVAL.radius, OVAL.cz, SOUTH, OVAL.trackWidth + 1),
    line("oval-south", OVAL.cx, OVAL.cz + OVAL.radius, WEST, OVAL.trackWidth + 1),
    line("oval-west", OVAL.cx - OVAL.halfStraight - OVAL.radius, OVAL.cz, NORTH, OVAL.trackWidth + 1),
]);
/** The gaps in the outer rail to ride in and out: at the two ends of the north straight's stand side. */
export const OVAL_GAPS = Object.freeze([
    Object.freeze({ from: OVAL.cx + OVAL.halfStraight - 7, to: OVAL.cx + OVAL.halfStraight - 1 }),
    Object.freeze({ from: OVAL.cx - OVAL.halfStraight + 1, to: OVAL.cx - OVAL.halfStraight + 7 }),
]);
/** A point on the oval at `share` of the way round (0 = the finish line, clockwise), `offset` metres out from the centreline. */
export function ovalPoint(share, offset = 0) {
    const { cx, cz, halfStraight, radius } = OVAL;
    const straight = halfStraight * 2;
    const curve = Math.PI * radius;
    const total = straight * 2 + curve * 2;
    let distance = (((share % 1) + 1) % 1) * total;
    const r = radius + offset;
    // North straight, from the finish (x = cx) east to its end, then the east curve, the south straight west, the west curve, back.
    const northHalf = halfStraight;
    if (distance < northHalf)
        return { x: cx + distance, z: cz - r, heading: EAST };
    distance -= northHalf;
    if (distance < curve) {
        const angle = distance / radius;
        return { x: cx + halfStraight + Math.sin(angle) * r, z: cz - Math.cos(angle) * r, heading: EAST - angle };
    }
    distance -= curve;
    if (distance < straight)
        return { x: cx + halfStraight - distance, z: cz + r, heading: WEST };
    distance -= straight;
    if (distance < curve) {
        const angle = distance / radius;
        return { x: cx - halfStraight - Math.sin(angle) * r, z: cz + Math.cos(angle) * r, heading: WEST - angle };
    }
    distance -= curve;
    return { x: cx - halfStraight + distance, z: cz - r, heading: EAST };
}
export const OVAL_LAP_METRES = OVAL.halfStraight * 4 + Math.PI * OVAL.radius * 2;
/** The oval's rails as short straight boxes (the inner ring whole, the outer with its gaps). */
export function ovalRails() {
    const rails = [];
    const add = (a, b) => {
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 0.01)
            return;
        // A box's width runs along its own x: turn it to lie along the segment.
        rails.push(Object.freeze({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, rotationY: -Math.atan2(dz, dx), footprint: Object.freeze({ width: length, depth: 0.16 }) }));
    };
    for (const offset of [-OVAL.trackWidth / 2, OVAL.trackWidth / 2]) {
        const steps = 96;
        for (let index = 0; index < steps; index += 1) {
            const a = ovalPoint(index / steps, offset);
            const b = ovalPoint((index + 1) / steps, offset);
            const outer = offset > 0;
            const onNorth = Math.abs(a.z - (OVAL.cz - OVAL.radius - offset)) < 0.01 && Math.abs(b.z - a.z) < 0.01;
            if (outer && onNorth && OVAL_GAPS.some((gap) => Math.max(a.x, b.x) > gap.from && Math.min(a.x, b.x) < gap.to))
                continue;
            add(a, b);
        }
    }
    return rails;
}
// ---------------------------------------------------------------- the cross-country trail
/** The trail, as the waypoints its ribbon is drawn through (start by the Green, round the west and the south, home up the east). */
export const XC_TRAIL = Object.freeze([
    point(66, -8), point(40, -10), point(10, -11), point(-12, -16), point(-28, -20), point(-48, -14), point(-68, -18),
    point(-84, -26), point(-86, -12), point(-86, 6), point(-86, 22), point(-88, 38), point(-90, 52), point(-88, 66),
    point(-76, 74), point(-50, 74), point(-20, 74), point(10, 74), point(40, 74), point(62, 70), point(66, 56),
    point(66, 40), point(67, 26),
]);
export const XC_START = line("xc-start", 60, -8.5, WEST, 10);
export const XC_FINISH = line("xc-finish", 67, 22, NORTH, 10);
const earthwork = (id) => DOWNS_EARTHWORKS.find((work) => work.id === id);
/** The cross-country fences, in order. Earthworks are fences with no height to clear — they are ridden through. */
function xcFences(championship) {
    const up = championship ? 0.2 : 0;
    const bank = earthwork("xc-bank");
    const drop = earthwork("xc-drop");
    const ditch = earthwork("xc-ditch");
    const splash = earthwork("xc-splash");
    return [
        fence("xc-1", "log", 34, -10.2, WEST, 1, 0.6 + up, 4),
        fence("xc-2", "hedge", -2, -13.5, WEST, 2, 0.85 + up, 4.5),
        fence("xc-3", "ditch", ditch.x, ditch.z, WEST, 3, 0.25, ditch.width, ditch.depth),
        fence("xc-4", "brush", -58, -16, WEST, 4, 1.0 + up, 4.5),
        fence("xc-5", "bank", bank.x, bank.z, SOUTH, 5, 0, bank.width, 2),
        fence("xc-6", "log", -86, 8, SOUTH, 6, 0.7 + up, 4),
        fence("xc-7", "drop", drop.x, drop.z, SOUTH, 7, 0, drop.width, 2),
        fence("xc-8", "splash", splash.x, splash.z, SOUTH, 8, 0, splash.width, 3),
        fence("xc-9", "hedge", -36, 74, EAST, 9, 0.9 + up, 5),
        fence("xc-10", "log", 0, 74, EAST, 10, 0.75 + up, 4),
        fence("xc-11", "wall", 28, 74, EAST, 11, 0.95 + up, 4.5),
        fence("xc-12", "brush", 66, 48, NORTH, 12, 1.05 + up, 4.5),
    ];
}
export const XC_FENCES = Object.freeze(xcFences(false));
export const XC_CHAMPIONSHIP_FENCES = Object.freeze(xcFences(true));
/** Loose fences in the open country, jumped for the fun of it (no course). */
export const OPEN_COUNTRY_FENCES = Object.freeze([
    fence("free-1", "log", -40, -46, WEST, 0, 0.6, 4),
    fence("free-2", "hedge", -20, -50, EAST, 0, 0.9, 5),
    fence("free-3", "log", -70, -52, NORTH, 0, 0.7, 4),
    fence("free-4", "brush", 0, -40, SOUTH, 0, 1.0, 4),
    fence("free-5", "log", 84, 34, NORTH, 0, 0.6, 4),
    fence("free-6", "wall", 80, 66, WEST, 0, 0.9, 4),
]);
const prop = (id, kind, x, z, rotationY, width, depth, solid = true, label) => Object.freeze({ id, kind, x, z, rotationY, width, depth, solid, ...(label ? { label } : {}) });
/** Where the board, the booth and the race board stand: E there opens them. */
export const DOWNS_NOTICE_BOARD = "downs-board";
export const DOWNS_BETTING_BOOTH = "downs-booth";
export const DOWNS_RACE_BOARD = "downs-raceboard";
function trees() {
    const spots = [
        [90, -30, "tree"], [94, 28, "pine"], [88, -44, "pine"], [74, -52, "tree"], [-4, -28, "tree"], [-16, -34, "pine"],
        [-36, -28, "tree"], [-60, -40, "pine"], [-74, -30, "tree"], [-94, -40, "pine"], [-95, -60, "tree"], [-60, -60, "tree"],
        [-30, -58, "pine"], [10, -56, "tree"], [40, -56, "pine"], [-95, 0, "tree"], [-96, 30, "pine"], [-80, 60, "tree"],
        [-95, 78, "pine"], [-64, 66, "tree"], [-10, 40, "pine"], [48, 64, "tree"], [80, 76, "pine"], [92, 60, "tree"],
        [80, 20, "tree"], [72, 34, "pine"], [58, 2, "tree"], [30, 2, "pine"], [-60, 2, "tree"], [-40, 0, "pine"],
    ];
    return spots.map(([x, z, kind], index) => prop(`downs-${kind}-${index}`, kind, x, z, index * 0.7, 1.2, 1.2));
}
export const DOWNS_PROPS = Object.freeze([
    // The Hitching Green.
    prop("downs-trough", "trough", 88, -9, 0, 2.4, 0.9),
    prop(DOWNS_NOTICE_BOARD, "board", 86, 9, Math.PI, 2.2, 0.5, true, "Windrush Downs"),
    prop("downs-rail-green", "rail", 92, 12, 0, 2.4, 0.3),
    prop("downs-bench-green", "bench", 80, -12, 0, 1.6, 0.6),
    prop("downs-lamp-green-1", "lamp", 95, -5, 0, 0.3, 0.3),
    prop("downs-lamp-green-2", "lamp", 95, 5, 0, 0.3, 0.3),
    // The gallop's start and finish.
    prop("downs-gallop-start", "arch", GALLOP_START.x, GALLOP_START.z, GALLOP_START.heading, 14, 0.4, false, "GALLOP · START"),
    prop("downs-gallop-finish", "arch", GALLOP_FINISH.x, GALLOP_FINISH.z, GALLOP_FINISH.heading, 14, 0.4, false, "FINISH"),
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((index) => prop(`downs-furlong-${index}`, "marker", GALLOP_START.x - index * 20, -60.6, 0, 0.3, 0.3, true, String(index * 20))),
    // The oval's stand, betting booth and race board, north of the north straight.
    prop("downs-stand", "stand", OVAL.cx, OVAL.cz - OVAL_OUTER - 8, SOUTH, 22, 6),
    prop(DOWNS_BETTING_BOOTH, "booth", OVAL.cx + 17, OVAL.cz - OVAL_OUTER - 6, SOUTH, 3, 2.4, true, "BETTING"),
    prop(DOWNS_RACE_BOARD, "raceboard", OVAL.cx - 17, OVAL.cz - OVAL_OUTER - 6, SOUTH, 4, 0.5, true, "RACES"),
    prop("downs-oval-finish", "post", OVAL_FINISH.x, OVAL_FINISH.z - OVAL.trackWidth / 2 - 0.6, 0, 0.3, 0.3, true, "FINISH"),
    // The cross-country's start and finish.
    prop("downs-xc-start", "arch", XC_START.x, XC_START.z, XC_START.heading, 10, 0.4, false, "CROSS-COUNTRY"),
    prop("downs-xc-finish", "arch", XC_FINISH.x, XC_FINISH.z, XC_FINISH.heading, 10, 0.4, false, "FINISH"),
    ...trees(),
]);
// ---------------------------------------------------------------- the solids
/** The perimeter fence, with its gate to the square open, as boxes. */
export function perimeterFence() {
    const w = DOWNS_HALF_WIDTH - 0.5;
    const d = DOWNS_HALF_DEPTH - 0.5;
    const box = (x, z, width, depth) => Object.freeze({ x, z, rotationY: 0, footprint: Object.freeze({ width, depth }) });
    const gateHalf = DOWNS_GATE.width / 2;
    return [
        box(0, -d, w * 2, 0.2),
        box(0, d, w * 2, 0.2),
        box(-w, 0, 0.2, d * 2),
        box(w, (-d + (DOWNS_GATE.z - gateHalf)) / 2, 0.2, (DOWNS_GATE.z - gateHalf) + d),
        box(w, (d + (DOWNS_GATE.z + gateHalf)) / 2, 0.2, d - (DOWNS_GATE.z + gateHalf)),
    ];
}
/** A ring's rail as four sides, the south side split round its entrance. */
export function ringRails(ring) {
    const { minX, maxX, minZ, maxZ } = ring.zone;
    const box = (x, z, width, depth) => Object.freeze({ x, z, rotationY: 0, footprint: Object.freeze({ width, depth }) });
    const half = RING_GATE_WIDTH / 2;
    return [
        box((minX + maxX) / 2, minZ, maxX - minX, 0.16),
        box(minX, (minZ + maxZ) / 2, 0.16, maxZ - minZ),
        box(maxX, (minZ + maxZ) / 2, 0.16, maxZ - minZ),
        box((minX + ring.gate.x - half) / 2, maxZ, ring.gate.x - half - minX, 0.16),
        box((maxX + ring.gate.x + half) / 2, maxZ, maxX - (ring.gate.x + half), 0.16),
    ];
}
/** Everything solid at the Downs. */
export function downsSolids() {
    const props = DOWNS_PROPS.filter((entry) => entry.solid).map((entry) => {
        const trunk = entry.kind === "tree" || entry.kind === "pine";
        return Object.freeze({ x: entry.x, z: entry.z, rotationY: entry.rotationY, footprint: Object.freeze({ width: trunk ? 0.6 : entry.width, depth: trunk ? 0.6 : entry.depth }) });
    });
    return [...perimeterFence(), ...DOWNS_RINGS.flatMap(ringRails), ...ovalRails(), ...props];
}
/** Every fence at the Downs as the ride sim's jumps (the flags and earthworks have no height, so they never fault). */
export function downsJumps(championship = false) {
    const fences = [...NOVICE_FENCES, ...OPEN_FENCES, ...(championship ? XC_CHAMPIONSHIP_FENCES : XC_FENCES), ...OPEN_COUNTRY_FENCES];
    return fences.filter((entry) => entry.clearance > 0).map((entry) => Object.freeze({ id: entry.id, x: entry.x, z: entry.z, rotationY: entry.heading, width: entry.width, depth: entry.depth, clearance: entry.clearance }));
}
/** True when a rider at `pose` is in the east gateway, on the way back to the square. */
export function inDownsGateway(pose) {
    return pose.x >= DOWNS_GATE.x - DOWNS_GATE_DEPTH && Math.abs(pose.z - DOWNS_GATE.z) <= DOWNS_GATE.width / 2 - 0.6;
}
/** The ground's height, re-exported for the page's one import. */
export const downsGroundAt = downsGround;
export const DOWNS_WALKER_BOUNDS = Object.freeze({ halfWidth: DOWNS_HALF_WIDTH, halfDepth: DOWNS_HALF_DEPTH, margin: DOWNS_BOUNDS.wallInset });
