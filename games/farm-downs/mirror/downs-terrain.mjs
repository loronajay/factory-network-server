// The lie of the land at Windrush Downs (planning-docs/FARM_RIDING_PLAN.md).
//
// Rolling ground matters more here than anywhere else in the farm's world: a
// gallop up a hill is a gallop that costs wind, and the cross-country trail
// has a bank to go up and a drop to go down. So the Downs has a heightfield —
// ONE function, `downsGround`, that the ground mesh, the ride sim and every
// placement read, the way the farm's ponds are one profile everyone reads.
//
// The land rolls everywhere but where a thing needs it flat (the Hitching
// Green, the gallop strip, the show rings, the oval), and there it is eased
// flat over a few metres. A couple of rises give the place its skyline — the
// Knoll in the north-west, where you can see the whole Downs from. The
// cross-country trail's bank, drop, ditch and water splash are cut into it
// here too, so the rider's hooves and the grass are always the same ground.
//
// Pure: no THREE, no DOM. The coordinates are metres, x east, z south, the
// Market Square's west gate off the east edge.
export const DOWNS_BOUNDS = Object.freeze({ width: 200, depth: 160, wallInset: 1 });
export const DOWNS_HALF_WIDTH = DOWNS_BOUNDS.width / 2;
export const DOWNS_HALF_DEPTH = DOWNS_BOUNDS.depth / 2;
const rect = (minX, maxX, minZ, maxZ) => Object.freeze({ minX, maxX, minZ, maxZ });
/** The flat places, each eased into the hills over `DOWNS_FLAT_FEATHER` metres. */
export const DOWNS_ZONES = Object.freeze({
    green: rect(70, 99, -16, 16),
    gallop: rect(-96, 92, -74, -60),
    novice: rect(14, 40, -48, -20),
    open: rect(46, 72, -48, -20),
    oval: rect(-78, 58, 8, 72),
});
export const DOWNS_FLAT_FEATHER = 9;
const RISES = Object.freeze([
    Object.freeze({ x: -52, z: -30, height: 7.5, radius: 20 }), // the Knoll
    Object.freeze({ x: 8, z: -6, height: 2.6, radius: 16 }),
    Object.freeze({ x: 84, z: 50, height: 4.2, radius: 14 }),
    Object.freeze({ x: -92, z: 76, height: 3, radius: 12 }),
]);
/** The trail's earthworks (the cross-country course names them as fences). */
export const DOWNS_EARTHWORKS = Object.freeze([
    Object.freeze({ id: "xc-bank", kind: "bank", x: -84, z: -12, heading: Math.PI, width: 8, depth: 7, height: 0.9 }),
    Object.freeze({ id: "xc-drop", kind: "drop", x: -86, z: 22, heading: Math.PI, width: 8, depth: 7, height: 0.9 }),
    Object.freeze({ id: "xc-ditch", kind: "ditch", x: -28, z: -20, heading: Math.PI / 2, width: 9, depth: 2, height: 0.9 }),
    Object.freeze({ id: "xc-splash", kind: "splash", x: -90, z: 52, heading: Math.PI, width: 12, depth: 12, height: 0.45 }),
]);
/** The stream along the Downs' south side (a shallow wade, never deep). */
export const DOWNS_STREAM = Object.freeze({ z: 77, halfWidth: 1.6, depth: 0.35 });
const smooth = (edge0, edge1, value) => {
    const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
};
/** Distance outside a rectangle (0 inside). */
function outside(zone, x, z) {
    const dx = Math.max(zone.minX - x, 0, x - zone.maxX);
    const dz = Math.max(zone.minZ - z, 0, z - zone.maxZ);
    return Math.hypot(dx, dz);
}
/** 1 where a flat place is, easing to 0 over the feather. */
export function downsFlatness(x, z) {
    let flat = 0;
    for (const zone of Object.values(DOWNS_ZONES)) {
        const distance = outside(zone, x, z);
        flat = Math.max(flat, 1 - smooth(0, DOWNS_FLAT_FEATHER, distance));
    }
    return flat;
}
function rolling(x, z) {
    return 1.35 * Math.sin(x / 23 + 0.7) * Math.cos(z / 19 - 0.4)
        + 0.85 * Math.sin((x + z) / 37 + 1.3)
        + 0.45 * Math.cos(x / 11.5 - z / 29)
        + 0.3 * Math.sin(z / 8.5 + x / 41);
}
/** A point in an earthwork's own frame: `along` runs with the trail through it. */
function localTo(work, x, z) {
    const forwardX = -Math.sin(work.heading);
    const forwardZ = -Math.cos(work.heading);
    const dx = x - work.x;
    const dz = z - work.z;
    return { along: dx * forwardX + dz * forwardZ, across: dx * forwardZ - dz * forwardX };
}
function earthworkLift(work, x, z) {
    const { along, across } = localTo(work, x, z);
    const edge = 1 - smooth(work.width / 2 - 1, work.width / 2 + 2, Math.abs(across));
    if (edge <= 0)
        return 0;
    if (work.kind === "bank") {
        // Up a steep face at the middle, and a long plateau beyond that eases away.
        return work.height * smooth(-0.35, 0.35, along) * (1 - smooth(work.depth, work.depth + 8, along)) * edge;
    }
    if (work.kind === "drop") {
        // A plateau before, a steep face down at the middle.
        return work.height * (1 - smooth(-0.35, 0.35, along)) * smooth(-work.depth - 8, -work.depth, along) * edge;
    }
    if (work.kind === "ditch") {
        const across2 = Math.abs(along);
        return -work.height * (1 - smooth(work.depth / 2 - 0.2, work.depth / 2 + 0.4, across2)) * edge;
    }
    // The splash: a shallow dish the water stands in.
    const reach = Math.hypot(along / (work.depth / 2), across / (work.width / 2));
    return -work.height * 1.6 * (1 - smooth(0.6, 1.15, reach));
}
/** The ground's height at a point. */
export function downsGround(point) {
    const { x, z } = point;
    let height = rolling(x, z);
    for (const rise of RISES) {
        const distance = Math.hypot(x - rise.x, z - rise.z);
        height += rise.height * Math.exp(-(distance * distance) / (2 * rise.radius * rise.radius));
    }
    height *= 1 - downsFlatness(x, z);
    for (const work of DOWNS_EARTHWORKS)
        height += earthworkLift(work, x, z);
    // The stream cuts a shallow bed along the south side.
    const stream = Math.abs(z - DOWNS_STREAM.z);
    height -= DOWNS_STREAM.depth * 1.8 * (1 - smooth(DOWNS_STREAM.halfWidth, DOWNS_STREAM.halfWidth + 2.5, stream));
    return height;
}
/** The water's surface where there is water (the splash, the stream), or null. */
export function downsWaterSurface(point) {
    const splash = DOWNS_EARTHWORKS.find((work) => work.kind === "splash");
    const { along, across } = localTo(splash, point.x, point.z);
    if (Math.hypot(along / (splash.depth / 2), across / (splash.width / 2)) < 1)
        return downsGround({ x: splash.x, z: splash.z }) + splash.height;
    if (Math.abs(point.z - DOWNS_STREAM.z) < DOWNS_STREAM.halfWidth + 1.2)
        return -DOWNS_STREAM.depth * 0.8;
    return null;
}
/** How much water stands over a point (the ride sim slows a horse in it; none is ever deep enough to stop one). */
export function downsWaterDepth(point) {
    const surface = downsWaterSurface(point);
    if (surface === null)
        return 0;
    return Math.max(0, surface - downsGround(point));
}
