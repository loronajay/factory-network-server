(function attachMallPlan(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MallPlan = api;
})(typeof window !== 'undefined' ? window : globalThis, function createMallPlanApi(root) {
  'use strict';

  // The generic plan geometry — bounds, hinges, collider resolution, walk heights — is shared with
  // every other map from `collision-logic.js`, and re-exported below so this module satisfies the
  // same helper surface `sim-logic.createPlanSpace` asks any plan for.
  const geometry = typeof require === 'function' ? require('./collision-logic.js') : root.HotelCollision;

  // Cinder Mall, as data.
  //
  // Two levels wrapped around an atrium void, with three of the staff still on shift. It is the
  // second building in the game and the first one that had to prove the registry was real: nothing
  // in the renderer, the menu or the composition root knows this file exists. `map-catalog.js` names
  // it, `modules/hotel.js` walks whatever comes back, and the authoritative tick spawns whatever
  // demons the catalog row lists.
  //
  // There is no renderer in here. Not a THREE import, not a mesh, not a material instance — only
  // plain numbers in world space, because a server has to be able to say where the walls are.
  //
  // Authored from cinder-mall-reference/cinder-mall-v4.1-fixed.html. Keep its footprint, glazing,
  // twenty shop entrances, shop-specific interiors and south lift; game-owned doors, keys and
  // navigation are layered onto that architecture. North/south below use world +Z/-Z respectively.
  //
  // Heat zones fall out of the same records: every store is a `room` (fills the meter, can be
  // hunted), the concourse is hallway by omission, and the two service corridors are `tunnel`, which
  // drains it.

  const HALF_TURN = Math.PI / 2;
  const WALL_H = 3.2;
  const SHELL_H = 7.8;

  // The footprint. 96m across and 72m deep, which is what buys three demons two floors: the
  // separation the hotel got from stacking storeys, this building gets from sheer width.
  const SHELL = Object.freeze({ minX: -48, maxX: 48, minZ: -36, maxZ: 36 });

  // The reference lift opens toward +Z, into the south concourse.
  const LIFT = Object.freeze({ centerX: 34, centerZ: -29, frontZ: -26.9, halfWidth: 1.65, halfDepth: 2.1 });

  // The service stair core, north-east, sitting outside the north gallery's slab.
  const STAIR = Object.freeze({
    xWest: 39.5, xEast: 47, zSouth: 20, zNorth: 34,
    westLane: 41.2, eastLane: 45.3, landingX: 43.25,
    doorZ: 22.4, doorWidth: 1.8,
  });

  // The escalator pair, running from the ground atrium up to the south edge of the upper gallery.
  const ESCALATORS = Object.freeze([
    Object.freeze({ id: 'escalator-west', x: 2, startZ: 7, endZ: -11, width: 2.1 }),
    Object.freeze({ id: 'escalator-east', x: 4.5, startZ: 7, endZ: -11, width: 2.1 }),
  ]);

  // The atrium void: the hole the upper gallery is a ring around.
  const ATRIUM = Object.freeze({ minX: -14, maxX: 14, minZ: -11, maxZ: 11 });

  const FLOOR_DEFS = Object.freeze([
    Object.freeze({ id: 1, name: 'Concourse' }),
    Object.freeze({ id: 2, name: 'Upper Gallery' }),
  ]);

  // The tenancies. `front` names the side that opens onto the concourse and `entry` is where along
  // that side the door hangs. A `locked` store needs its level's master key; a `key` store hides that
  // master in one of its own drawers.
  const STORES = Object.freeze([
    // --- ground ---------------------------------------------------------------------------------
    Object.freeze({ id: '101', floor: 1, name: 'ANCHOR DEPARTMENT', minX: -47.5, maxX: -25, minZ: -28, maxZ: 30, front: 'east', entry: 8, entries: [-14, 8, 24], material: 'carpetRed', target: [-27, 8] }),
    Object.freeze({ id: '102', floor: 1, name: 'RESTROOMS', minX: -23, maxX: -8, minZ: -35, maxZ: -23, front: 'north', entry: -15.5, material: 'tile', target: [-15.5, -25] }),
    Object.freeze({ id: '103', floor: 1, name: 'SECURITY', minX: 8, maxX: 23, minZ: -35, maxZ: -23, front: 'north', entry: 15.5, material: 'carpetRed', locked: true, target: [15.5, -25.5] }),
    Object.freeze({ id: '104', floor: 1, name: 'FOOD COURT', minX: 24, maxX: 47.5, minZ: -24, maxZ: -12, front: 'west', entry: -21, entries: [-21, -15], material: 'tile', target: [26, -18] }),
    Object.freeze({ id: '105', floor: 1, name: 'ARCADE', minX: 30, maxX: 47.5, minZ: -9, maxZ: 8, front: 'west', entry: -4, entries: [-4, 4], material: 'carpetRed', key: true, target: [32, -4] }),
    Object.freeze({ id: '106', floor: 1, name: 'PHARMACY', minX: 19, maxX: 36, minZ: 13, maxZ: 30, front: 'south', entry: 25, material: 'tile', target: [25, 14] }),
    Object.freeze({ id: '107', floor: 1, name: 'RECEIVING', minX: 38, maxX: 47.5, minZ: 13, maxZ: 18.5, front: 'south', entry: 43, material: 'service', locked: true, target: [43, 14.5] }),
    // --- upper ----------------------------------------------------------------------------------
    Object.freeze({ id: '201', floor: 2, name: 'ANCHOR HOME', minX: -47.5, maxX: -25, minZ: -28, maxZ: 30, front: 'east', entry: 9, entries: [-13, 9, 24], material: 'carpetRed', target: [-27, 9] }),
    Object.freeze({ id: '202', floor: 2, name: 'TOY STORE', minX: -23, maxX: -8, minZ: -35, maxZ: -23, front: 'north', entry: -15.5, material: 'floor2', target: [-15.5, -28] }),
    Object.freeze({ id: '203', floor: 2, name: 'SALON', minX: -6, maxX: 8, minZ: -35, maxZ: -23, front: 'north', entry: 1, material: 'tile', target: [1, -25] }),
    Object.freeze({ id: '204', floor: 2, name: 'BOOKSTORE', minX: 10, maxX: 29, minZ: -35, maxZ: -23, front: 'north', entry: 19.5, material: 'carpetRed', key: true, target: [19.5, -28] }),
    Object.freeze({ id: '205', floor: 2, name: 'CINEMA', minX: 20, maxX: 38, minZ: 12, maxZ: 35, front: 'south', entry: 24.5, entries: [24.5, 34.5], material: 'carpetRed', target: [24.5, 16.5] }),
    Object.freeze({ id: '206', floor: 2, name: 'MANAGEMENT', minX: -3, maxX: 17, minZ: 20, maxZ: 35, front: 'south', entry: 7, material: 'floor2', locked: true, target: [7, 22] }),
  ]);

  const clean = (value) => (Math.abs(value) < 1e-12 ? 0 : Number(Number(value).toFixed(9)));
  const { boxBounds } = geometry;

  function createMallPlan({ config, floorDefs = FLOOR_DEFS, layout, floorY, keyIdForFloor, keyLabelForFloor }) {
    const FLOOR_H = config.floorHeight;
    const boxes = [];
    const surfaces = [];
    const swingDoors = [];
    const slidingDoors = [];
    const roomDoors = [];
    const secretPanels = [];
    const secretTunnels = [];
    const roomCenters = [];
    const storeEntries = [];
    const furnishings = [];
    const hallDoors = [];
    const signs = [];
    const doorFrames = [];
    const wallLamps = [];
    const lights = [];
    const fixtures = [];
    const stairs = { treads: [], rails: [] };

    const levelY = (floor) => (floor - 1) * FLOOR_H;

    // --- primitives -----------------------------------------------------------------------------

    function box({ floor, group = 'floor', kind, material, collider = true, x, localY, z, w, h, d, rotationY = 0, id = null, ...extra }) {
      boxes.push({
        floor, group, kind, material, collider, id,
        x: clean(x), y: clean(levelY(floor) + localY), z: clean(z),
        w: clean(w), h: clean(h), d: clean(d), rotationY, localY: clean(localY), ...extra,
      });
    }

    // A wall running along X (thin in Z).
    function wallX({ floor, x, z, width, base = 0, height = WALL_H, material = 'wall' }) {
      if (width <= 0.02) return;
      box({ floor, kind: 'wall', material, x, localY: base + height / 2, z, w: width, h: height, d: 0.22 });
    }

    // A wall running along Z (thin in X).
    function wallZ({ floor, x, z, depth, base = 0, height = WALL_H, material = 'wall' }) {
      if (depth <= 0.02) return;
      box({ floor, kind: 'wall', material, x, localY: base + height / 2, z, w: 0.22, h: height, d: depth });
    }

    // A wall with holes in it. `openings` carry a centre and a width along the wall's own axis, and
    // each keeps a header above it so a gap reads as a doorway rather than as a missing wall.
    function splitWall({ floor, axis, fixed, from, to, openings = [], base = 0, height = WALL_H, material = 'wall' }) {
      const sorted = openings.slice().sort((a, b) => a.center - b.center);
      let cursor = from;
      for (const opening of sorted) {
        const low = opening.center - opening.width / 2;
        const high = opening.center + opening.width / 2;
        if (low > cursor + 0.02) {
          const center = (cursor + low) / 2;
          const length = low - cursor;
          if (axis === 'x') wallX({ floor, x: center, z: fixed, width: length, base, height, material });
          else wallZ({ floor, x: fixed, z: center, depth: length, base, height, material });
        }
        const clearance = opening.height || 2.35;
        const headerH = Math.max(0.15, height - clearance);
        const headerY = base + clearance + headerH / 2;
        if (axis === 'x') box({ floor, kind: 'wall', material, x: opening.center, localY: headerY, z: fixed, w: opening.width, h: headerH, d: 0.22 });
        else box({ floor, kind: 'wall', material, x: fixed, localY: headerY, z: opening.center, w: 0.22, h: headerH, d: opening.width });
        cursor = high;
      }
      if (cursor < to - 0.02) {
        const center = (cursor + to) / 2;
        const length = to - cursor;
        if (axis === 'x') wallX({ floor, x: center, z: fixed, width: length, base, height, material });
        else wallZ({ floor, x: fixed, z: center, depth: length, base, height, material });
      }
    }

    // A walkable slab. `priority` breaks ties where two surfaces overlap.
    function slab({ floor, minX, maxX, minZ, maxZ, material = 'floor1', priority = 0 }) {
      if (maxX - minX <= 0.02 || maxZ - minZ <= 0.02) return;
      box({
        floor, kind: 'slab', material, collider: false,
        x: (minX + maxX) / 2, localY: priority > 0 ? 0.0125 : -0.1, z: (minZ + maxZ) / 2,
        w: maxX - minX, h: priority > 0 ? 0.025 : 0.2, d: maxZ - minZ,
      });
      surfaces.push({
        kind: 'rect', floor, priority,
        minX: clean(minX), maxX: clean(maxX), minZ: clean(minZ), maxZ: clean(maxZ),
        y: clean(levelY(floor)),
      });
    }

    function ceiling({ floor, minX, maxX, minZ, maxZ }) {
      if (maxX - minX <= 0.02 || maxZ - minZ <= 0.02) return;
      box({
        floor, kind: 'ceiling', material: 'ceiling', collider: false,
        x: (minX + maxX) / 2, localY: WALL_H, z: (minZ + maxZ) / 2,
        w: maxX - minX, h: 0.12, d: maxZ - minZ,
      });
    }

    function pointLight({ floor, x, z, localY = 2.6, color = 0xb00000, intensity = 0.58, distance = 9 }) {
      lights.push({
        floor, kind: 'point', color, intensity, distance, decay: 2,
        x: clean(x), y: clean(levelY(floor) + localY), z: clean(z), localY: clean(localY),
      });
    }

    // A hinged leaf, in the shape the renderer, the collider and the server all read. The hinge sits
    // at one edge of the opening and the leaf hangs off it, so a swing is one rotation about the
    // hinge rather than a translation anything downstream has to re-derive.
    function hingedLeaf({ id, kind, floor, axis, fixed, center, width, openAngle, extra = {} }) {
      const alongZ = axis === 'z';
      return {
        id, kind, floor,
        side: openAngle < 0 ? 'left' : 'right',
        direction: openAngle < 0 ? -1 : 1,
        x: clean(alongZ ? fixed : center),
        z: clean(alongZ ? center : fixed),
        width: clean(width),
        hingeX: clean(alongZ ? fixed : center - width / 2),
        hingeZ: clean(alongZ ? center - width / 2 : fixed),
        y: clean(levelY(floor) + 1.06),
        localX: clean(alongZ ? 0 : width / 2),
        localZ: clean(alongZ ? width / 2 : 0),
        w: clean(alongZ ? 0.1 : width),
        h: 2.12,
        d: clean(alongZ ? width : 0.1),
        openAngle,
        ...extra,
      };
    }

    function doorFrame({ floor, axis, fixed, center, width, height = 2.12, material = 'wood' }) {
      const alongZ = axis === 'z';
      doorFrames.push({
        floor,
        // The axis the opening runs along, so the jambs land either side of it rather than in it.
        axis: alongZ ? 'z' : 'x',
        x: clean(alongZ ? fixed - 0.07 : center),
        z: clean(alongZ ? center : fixed - 0.07),
        width: clean(width), height, material, localY: 0, y: clean(levelY(floor)),
      });
    }

    // --- the shell ------------------------------------------------------------------------------

    // Ground slab, split around the lift shaft so the shaft is a real hole rather than a box sitting
    // on the floor. A body that could stand on the shaft would be standing on the lift's roof.
    const shaftMinX = LIFT.centerX - LIFT.halfWidth;
    const shaftMaxX = LIFT.centerX + LIFT.halfWidth;
    const shaftMinZ = LIFT.centerZ - LIFT.halfDepth;
    const shaftMaxZ = LIFT.frontZ;

    slab({ floor: 1, minX: SHELL.minX, maxX: shaftMinX, minZ: SHELL.minZ, maxZ: SHELL.maxZ, material: 'tile' });
    slab({ floor: 1, minX: shaftMaxX, maxX: SHELL.maxX, minZ: SHELL.minZ, maxZ: SHELL.maxZ, material: 'tile' });
    slab({ floor: 1, minX: shaftMinX, maxX: shaftMaxX, minZ: SHELL.minZ, maxZ: shaftMinZ, material: 'tile' });
    slab({ floor: 1, minX: shaftMinX, maxX: shaftMaxX, minZ: shaftMaxZ, maxZ: SHELL.maxZ, material: 'tile' });
    // The pit floor. The cabin rests on it at level 1, and the seeker is held standing in the cabin
    // for the head start — a shaft cut all the way through would be a seeker with nothing under them.
    slab({ floor: 1, minX: shaftMinX, maxX: shaftMaxX, minZ: shaftMinZ, maxZ: shaftMaxZ, material: 'floor4' });

    // Upper gallery: a ring around the atrium void, split around the same shaft.
    slab({ floor: 2, minX: SHELL.minX, maxX: shaftMinX, minZ: -35, maxZ: ATRIUM.minZ, material: 'floor2' });
    slab({ floor: 2, minX: shaftMaxX, maxX: SHELL.maxX, minZ: -35, maxZ: ATRIUM.minZ, material: 'floor2' });
    slab({ floor: 2, minX: shaftMinX, maxX: shaftMaxX, minZ: -35, maxZ: shaftMinZ, material: 'floor2' });
    slab({ floor: 2, minX: shaftMinX, maxX: shaftMaxX, minZ: shaftMaxZ, maxZ: ATRIUM.minZ, material: 'floor2' });
    slab({ floor: 2, minX: SHELL.minX, maxX: ATRIUM.minX, minZ: ATRIUM.minZ, maxZ: ATRIUM.maxZ, material: 'floor2' });
    slab({ floor: 2, minX: ATRIUM.maxX, maxX: SHELL.maxX, minZ: ATRIUM.minZ, maxZ: ATRIUM.maxZ, material: 'floor2' });
    slab({ floor: 2, minX: SHELL.minX, maxX: STAIR.xWest, minZ: ATRIUM.maxZ, maxZ: 35, material: 'floor2' });
    slab({ floor: 2, minX: STAIR.xEast, maxX: 48, minZ: ATRIUM.maxZ, maxZ: 35, material: 'service' });
    slab({ floor: 2, minX: STAIR.xWest, maxX: STAIR.xEast, minZ: ATRIUM.maxZ, maxZ: STAIR.zSouth, material: 'floor2' });
    slab({ floor: 2, minX: STAIR.xWest, maxX: STAIR.xEast, minZ: STAIR.zNorth, maxZ: 36, material: 'service' });

    // Ceilings. They may cap a shaft, but never cross a walk path.
    ceiling({ floor: 2, minX: SHELL.minX, maxX: SHELL.maxX, minZ: -35, maxZ: ATRIUM.minZ });
    ceiling({ floor: 2, minX: SHELL.minX, maxX: ATRIUM.minX, minZ: ATRIUM.minZ, maxZ: ATRIUM.maxZ });
    ceiling({ floor: 2, minX: ATRIUM.maxX, maxX: SHELL.maxX, minZ: ATRIUM.minZ, maxZ: ATRIUM.maxZ });
    ceiling({ floor: 2, minX: SHELL.minX, maxX: SHELL.maxX, minZ: ATRIUM.maxZ, maxZ: 35 });

    // Outer shell, full height across both levels, with the main entrance punched in the south wall.
    splitWall({ floor: 1, axis: 'x', fixed: SHELL.minZ, from: SHELL.minX, to: SHELL.maxX, openings: [{ center: 0, width: 3.2, height: 3 }], base: 0, height: SHELL_H, material: 'dark' });
    wallX({ floor: 1, x: 0, z: SHELL.maxZ, width: SHELL.maxX - SHELL.minX, base: 0, height: SHELL_H, material: 'dark' });
    wallZ({ floor: 1, x: SHELL.minX, z: 0, depth: SHELL.maxZ - SHELL.minZ, base: 0, height: SHELL_H, material: 'dark' });
    wallZ({ floor: 1, x: SHELL.maxX, z: 0, depth: SHELL.maxZ - SHELL.minZ, base: 0, height: SHELL_H, material: 'dark' });
    doorFrame({ floor: 1, axis: 'x', fixed: SHELL.minZ, center: 0, width: 3.2, height: 3, material: 'brass' });
    signs.push({ floor: 1, text: 'CINDER MALL', x: 0, y: 5.7, z: clean(SHELL.minZ + 0.14), rotationY: 0, w: 12, h: 1.2, localY: 5.7 });

    // Balcony rails around the atrium void, with a gap where the escalators arrive.
    for (const rail of [
      { x: -7.25, z: ATRIUM.minZ, w: 13.5 }, { x: 10, z: ATRIUM.minZ, w: 8 },
      { x: 0, z: ATRIUM.maxZ, w: 28 },
    ]) box({ floor: 2, kind: 'trim', material: 'metal', x: rail.x, localY: 0.55, z: rail.z, w: rail.w, h: 1.05, d: 0.1 });
    for (const x of [ATRIUM.minX, ATRIUM.maxX]) {
      box({ floor: 2, kind: 'trim', material: 'metal', x, localY: 0.55, z: 0, w: 0.1, h: 1.05, d: ATRIUM.maxZ - ATRIUM.minZ });
    }

    // --- storefronts ----------------------------------------------------------------------------

    for (const store of STORES) {
      const { floor, minX, maxX, minZ, maxZ } = store;
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      const width = 2.2;

      slab({ floor, minX, maxX, minZ, maxZ, material: store.material, priority: 1 });
      if (floor === 1) ceiling({ floor, minX, maxX, minZ, maxZ });

      // Three solid sides and a continuous glazed frontage with all reference entrances.
      if (store.front !== 'north') wallX({ floor, x: cx, z: maxZ, width: maxX - minX });
      if (store.front !== 'south') wallX({ floor, x: cx, z: minZ, width: maxX - minX });
      if (store.front !== 'east') wallZ({ floor, x: maxX, z: cz, depth: maxZ - minZ });
      if (store.front !== 'west') wallZ({ floor, x: minX, z: cz, depth: maxZ - minZ });

      // The shopfront door hangs in whichever wall the front is, and swings into the store.
      const alongZ = store.front === 'east' || store.front === 'west';
      const fixed = store.front === 'north' ? maxZ : store.front === 'south' ? minZ : store.front === 'east' ? maxX : minX;
      const inward = store.front === 'north' || store.front === 'east' ? -1 : 1;
      const entries = store.entries || [store.entry];
      const from = alongZ ? minZ : minX, to = alongZ ? maxZ : maxX;
      box({ floor, kind: 'wall', material: 'dark', x: alongZ ? fixed : cx,
        z: alongZ ? cz : fixed, localY: 2.5 + (WALL_H - 2.5) / 2,
        w: alongZ ? 0.24 : to - from, h: WALL_H - 2.5, d: alongZ ? to - from : 0.24 });
      let cursor = from;
      for (const center of [...entries.slice().sort((a, b) => a - b), to + width / 2]) {
        const end = center - width / 2;
        if (end - cursor > 0.35) {
          box({ floor, kind: 'shopfront', material: 'glass', x: alongZ ? fixed : (cursor + end) / 2,
            z: alongZ ? (cursor + end) / 2 : fixed, localY: 1.26,
            w: alongZ ? 0.06 : end - cursor, h: 2.28, d: alongZ ? end - cursor : 0.06 });
          for (const edge of [cursor, end]) box({ floor, kind: 'trim', material: 'metal', collider: false,
            x: alongZ ? fixed : edge, z: alongZ ? edge : fixed, localY: 1.25,
            w: alongZ ? 0.16 : 0.08, h: 2.5, d: alongZ ? 0.08 : 0.16 });
        }
        if (center <= to) {
          storeEntries.push({ name: store.name, roomNumber: store.id, floor, axis: alongZ ? 'z' : 'x', fixed, center, outward: -inward });
          doorFrame({ floor, axis: alongZ ? 'z' : 'x', fixed, center, width, height: 2.5, material: 'metal' });
        }
        cursor = center + width / 2;
      }
      const door = hingedLeaf({
        id: `door-${store.id}`, kind: 'room', floor,
        axis: alongZ ? 'z' : 'x', fixed, center: store.entry, width,
        openAngle: (alongZ ? inward : -inward) * HALF_TURN,
        extra: {
          roomNumber: store.id,
          locked: !!store.locked,
          requiredKey: keyIdForFloor(floor),
          openInitially: !store.locked,
        },
      });
      roomDoors.push(door);
      swingDoors.push(door);
      // Targets lie in the entry aisle, not the geometric centre of a merchandise display.
      roomCenters.push({ roomNumber: store.id, floor, x: store.target[0], z: store.target[1], side: door.side,
        minX, maxX, minZ, maxZ });
      fixtures.push({
        kind: 'room-fill', floor, roomNumber: store.id, doorId: door.id,
        x: clean(cx), y: clean(levelY(floor) + WALL_H - 0.12), localY: clean(WALL_H - 0.12), z: clean(cz),
        w: 0.72, h: 0.06, d: 0.42, spec: layout.getRoomFillLight(floor),
      });

      // The fascia sign, hung outside the shopfront so it reads from the concourse.
      const outset = store.front === 'north' || store.front === 'east' ? 0.16 : -0.16;
      const facing = alongZ
        ? (store.front === 'east' ? HALF_TURN : -HALF_TURN)
        : (store.front === 'north' ? 0 : Math.PI);
      signs.push({
        floor, text: store.name,
        x: clean(alongZ ? fixed + outset : store.entry),
        y: clean(levelY(floor) + 2.84), z: clean(alongZ ? store.entry : fixed + outset),
        rotationY: facing,
        w: Math.min(7.5, Math.max(3.6, store.name.length * 0.34)), h: 0.78, localY: 2.84,
      });
      wallLamps.push({
        floor,
        x: clean(alongZ ? fixed + outset : store.entry + 2.2),
        y: clean(levelY(floor) + 2), localY: 2,
        z: clean(alongZ ? store.entry + 2.2 : fixed + outset),
        rotationY: facing,
      });
      pointLight({ floor, x: cx, z: cz, localY: 2.7, color: 0x8a1010, intensity: 0.5, distance: 11 });
    }

    // --- service corridors (the heat drains) ---------------------------------------------------

    // Behind the ground anchor store, and behind the upper cinema. Both are `tunnel` zones: standing
    // in one drains the heat meter, which is what makes a back-of-house route worth knowing.
    splitWall({
      floor: 1, axis: 'z', fixed: -43.5, from: -24, to: 26,
      openings: [{ center: -9, width: 1.6 }, { center: 18, width: 1.6 }], material: 'dark',
    });
    for (const center of [-9, 18]) {
      const roomNumber = `S1${center < 0 ? 'a' : 'b'}`;
      const leaf = hingedLeaf({
        id: `staff-door-1-${roomNumber}`, kind: 'room', floor: 1,
        axis: 'z', fixed: -43.5, center, width: 1.6, openAngle: HALF_TURN,
        extra: { roomNumber, locked: false, requiredKey: null, openInitially: false },
      });
      swingDoors.push(leaf);
      roomDoors.push(leaf);
      roomCenters.push({ roomNumber, floor: 1, x: -45.5, z: center, side: leaf.side });
      fixtures.push({
        kind: 'room-fill', floor: 1, roomNumber, doorId: leaf.id,
        x: -45.5, y: clean(WALL_H - 0.12), localY: clean(WALL_H - 0.12), z: center,
        w: 0.72, h: 0.06, d: 0.42, spec: layout.getRoomFillLight(1),
      });
      doorFrame({ floor: 1, axis: 'z', fixed: -43.5, center, width: 1.6 });
    }
    secretTunnels.push({ id: 'staff-corridor-1', kind: 'tunnel', floor: 1, minX: -47.5, maxX: -43.5, minZ: -24, maxZ: 26 });

    // Both auditoriums open into a rear corridor *inside* the cinema, not outside the shell.
    for (const [z, openings] of [
      [19, [{ center: 24.5, width: 1.6 }, { center: 33.5, width: 1.6 }, { center: 36.7, width: 1.4 }]],
      [31.7, [{ center: 23, width: 1.5 }, { center: 32, width: 1.5 }, { center: 36.7, width: 1.4 }]],
    ]) {
      splitWall({ floor: 2, axis: 'x', fixed: z, from: 20.2, to: 37.8, openings, material: 'dark' });
      for (const opening of openings) doorFrame({ floor: 2, axis: 'x', fixed: z, ...opening, height: 2.35 });
    }
    wallZ({ floor: 2, x: 29, z: 25.5, depth: 13, material: 'dark' });
    secretTunnels.push({ id: 'projection-corridor-2', kind: 'tunnel', floor: 2, minX: 20.2, maxX: 37.8, minZ: 31.7, maxZ: 35 });

    // --- vertical circulation ---------------------------------------------------------------------

    // Escalators. A body walks them like a ramp; nothing here moves, because a travelling tread the
    // server also has to agree about is a whole replication problem bought for a metre of scenery.
    for (const escalator of ESCALATORS) {
      const { x, startZ, endZ, width } = escalator;
      stairs.treads.push({ x, y: clean(FLOOR_H / 2 - 0.07), z: (startZ + endZ) / 2,
        w: width, h: 0.18, d: clean(Math.hypot(endZ - startZ, FLOOR_H)),
        rotationX: Math.atan2(FLOOR_H, Math.abs(endZ - startZ)), material: 'metal' });
      surfaces.push({
        kind: 'ramp', floor: 0, priority: 2,
        minX: clean(x - width / 2), maxX: clean(x + width / 2),
        minZ: clean(Math.min(startZ, endZ)), maxZ: clean(Math.max(startZ, endZ)),
        startZ: clean(startZ), endZ: clean(endZ), startY: 0, endY: clean(FLOOR_H),
      });
      const steps = 16;
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        stairs.treads.push({
          x: clean(x), y: clean(FLOOR_H * t + 0.02), z: clean(startZ + (endZ - startZ) * t),
          w: clean(width - 0.18), h: 0.06, d: clean(Math.abs(endZ - startZ) / steps + 0.05), rotationY: 0, material: 'dark',
        });
      }
      for (const side of [-1, 1]) {
        const railX = x + side * (width / 2 + 0.05);
        stairs.rails.push({
          start: { x: clean(railX), y: 0.88, z: clean(startZ) },
          end: { x: clean(railX), y: clean(FLOOR_H + 0.88), z: clean(endZ) },
        });
      }
    }

    // The enclosed service stair: two flights and a switchback landing — the same conventional shape
    // the hotel's stairwell uses, so `createStairRoute` describes it without a special case.
    const stairShell = {
      bounds: { xWest: STAIR.xWest - 0.3, xEast: STAIR.xEast + 0.3, zMin: STAIR.zSouth - 0.3, zMax: STAIR.zNorth + 0.3 },
    };
    const stairLayout = { entrances: [], landings: [], flights: [] };
    for (const def of floorDefs) {
      const y = levelY(def.id);
      stairLayout.entrances.push({ floor: def.id, x: clean(STAIR.xWest - 0.9), z: STAIR.doorZ, y: clean(y) });
      stairLayout.landings.push({ kind: 'floor', floor: def.id, x: STAIR.landingX, z: STAIR.doorZ, y: clean(y), w: 7.1, d: 2.1 });
      slab({ floor: def.id, minX: STAIR.xWest - 0.35, maxX: STAIR.xWest + 0.35,
        minZ: STAIR.doorZ - 0.9, maxZ: STAIR.doorZ + 0.9, material: 'service' });
      splitWall({
        floor: def.id, axis: 'z', fixed: STAIR.xWest, from: STAIR.zSouth, to: STAIR.zNorth,
        openings: [{ center: STAIR.doorZ, width: STAIR.doorWidth, height: 2.4 }], material: 'dark',
      });
      doorFrame({ floor: def.id, axis: 'z', fixed: STAIR.xWest, center: STAIR.doorZ, width: STAIR.doorWidth, height: 2.4 });
    }
    stairLayout.landings.push({ kind: 'switchback', transition: 1, x: STAIR.landingX, z: 32.8, y: clean(FLOOR_H / 2), w: 7.1, d: 2.1 });
    stairLayout.flights.push(
      { transition: 1, lane: 'west', startX: STAIR.westLane, startZ: 23.2, endX: STAIR.westLane, endZ: 31.8, startY: 0, endY: clean(FLOOR_H / 2), width: 1.35, steps: 18, railSide: -1 },
      { transition: 1, lane: 'east', startX: STAIR.eastLane, startZ: 31.8, endX: STAIR.eastLane, endZ: 23.2, startY: clean(FLOOR_H / 2), endY: clean(FLOOR_H), width: 1.35, steps: 18, railSide: 1 },
    );
    // The core's own shell, full height, closed on the three sides that are not its door.
    wallZ({ floor: 1, x: STAIR.xEast, z: (STAIR.zSouth + STAIR.zNorth) / 2, depth: STAIR.zNorth - STAIR.zSouth, base: 0, height: SHELL_H, material: 'dark' });
    wallX({ floor: 1, x: (STAIR.xWest + STAIR.xEast) / 2, z: STAIR.zNorth, width: STAIR.xEast - STAIR.xWest, base: 0, height: SHELL_H, material: 'dark' });
    wallX({ floor: 1, x: (STAIR.xWest + STAIR.xEast) / 2, z: STAIR.zSouth, width: STAIR.xEast - STAIR.xWest, base: 0, height: SHELL_H, material: 'dark' });

    for (const landing of stairLayout.landings) {
      stairs.treads.push({ x: landing.x, y: clean(landing.y - 0.07), z: landing.z, w: landing.w, h: 0.14, d: landing.d, rotationY: 0, material: 'service' });
      surfaces.push({
        kind: 'rect', floor: 0, priority: 1,
        minX: clean(landing.x - landing.w / 2), maxX: clean(landing.x + landing.w / 2),
        minZ: clean(landing.z - landing.d / 2), maxZ: clean(landing.z + landing.d / 2),
        y: clean(landing.y),
      });
    }
    for (const flight of stairLayout.flights) {
      for (let i = 0; i < flight.steps; i += 1) {
        const t = (i + 0.5) / flight.steps;
        stairs.treads.push({
          x: flight.startX,
          y: clean(flight.startY + (flight.endY - flight.startY) * ((i + 1) / flight.steps) - 0.055),
          z: clean(flight.startZ + (flight.endZ - flight.startZ) * t),
          w: flight.width, h: 0.11,
          d: clean(Math.abs(flight.endZ - flight.startZ) / flight.steps + 0.035), rotationY: 0, material: 'metal',
        });
      }
      surfaces.push({
        kind: 'ramp', floor: 0, priority: 2,
        minX: clean(flight.startX - flight.width / 2), maxX: clean(flight.startX + flight.width / 2),
        minZ: clean(Math.min(flight.startZ, flight.endZ)), maxZ: clean(Math.max(flight.startZ, flight.endZ)),
        startZ: clean(flight.startZ), endZ: clean(flight.endZ),
        startY: clean(flight.startY), endY: clean(flight.endY),
      });
      const railX = flight.startX + flight.railSide * (flight.width / 2 + 0.045);
      stairs.rails.push({
        start: { x: clean(railX), y: clean(flight.startY + 0.86), z: clean(flight.startZ) },
        end: { x: clean(railX), y: clean(flight.endY + 0.86), z: clean(flight.endZ) },
      });
    }

    // --- the lift ---------------------------------------------------------------------------------

    wallZ({ floor: 1, x: shaftMinX, z: LIFT.centerZ, depth: LIFT.halfDepth * 2, base: 0, height: SHELL_H + 0.3, material: 'dark' });
    wallZ({ floor: 1, x: shaftMaxX, z: LIFT.centerZ, depth: LIFT.halfDepth * 2, base: 0, height: SHELL_H + 0.3, material: 'dark' });
    wallX({ floor: 1, x: LIFT.centerX, z: shaftMinZ, width: LIFT.halfWidth * 2, base: 0, height: SHELL_H + 0.3, material: 'dark' });
    for (const def of floorDefs) {
      splitWall({
        floor: def.id, axis: 'x', fixed: LIFT.frontZ, from: shaftMinX, to: shaftMaxX,
        openings: [{ center: LIFT.centerX, width: 2.05, height: 2.4 }], material: 'dark',
      });
      doorFrame({ floor: def.id, axis: 'x', fixed: LIFT.frontZ, center: LIFT.centerX, width: 2.05, height: 2.4, material: 'brass' });
      signs.push({
        floor: def.id, text: String(def.id), x: LIFT.centerX,
        y: clean(levelY(def.id) + 2.78), z: clean(LIFT.frontZ + 0.13),
        rotationY: 0, w: 1.05, h: 0.55, localY: 2.78,
      });
      // The sill between the concourse and the cabin nose.
      surfaces.push({
        kind: 'rect', floor: def.id, priority: 1,
        minX: clean(LIFT.centerX - 1.02), maxX: clean(LIFT.centerX + 1.02),
        minZ: clean(LIFT.frontZ - 0.64), maxZ: clean(LIFT.frontZ + 0.1),
        y: clean(levelY(def.id)),
      });
      box({ floor: def.id, kind: 'slab', material: 'service', collider: false,
        x: LIFT.centerX, z: LIFT.frontZ - 0.27, localY: -0.09, w: 2.04, h: 0.18, d: 0.74 });
      box({ floor: def.id, kind: 'call-button', callFloor: def.id, collider: false, material: 'brass',
        x: LIFT.centerX + 1.42, z: LIFT.frontZ + 0.16, localY: 1.25, w: 0.12, h: 0.22, d: 0.06 });
      for (const side of ['left', 'right']) {
        const direction = side === 'left' ? -1 : 1;
        const leaf = {
          id: `hall-door-${def.id}-${side}`, kind: 'hall', floor: def.id, side, direction,
          centerX: LIFT.centerX, x: clean(LIFT.centerX + direction * 0.46),
          y: clean(levelY(def.id) + 1.175), localY: 1.175, z: clean(LIFT.frontZ - 0.05), w: 0.92, h: 2.35, d: 0.08,
        };
        hallDoors.push(leaf);
        slidingDoors.push(leaf);
      }
    }
    // The cabin floor is the one walkable surface whose height is state rather than geometry.
    surfaces.push({
      kind: 'dynamic', id: 'elevator-car', floor: 0, priority: 0,
      minX: clean(LIFT.centerX - 1.16), maxX: clean(LIFT.centerX + 1.16),
        minZ: clean(LIFT.centerZ - 1.47), maxZ: clean(LIFT.frontZ + 0.12),
    });

    // --- furnishings ------------------------------------------------------------------------------

    // Placements, not meshes. Ids are stable because a drawer is contested state online: two players
    // searching the same counter have to be searching the same counter.
    let placed = 0;
    function place(type, floor, x, z, rotationY = 0, extra = {}) {
      placed += 1;
      const placement = {
        id: `mx-${floor}-${placed}`, type, floor,
        x: clean(x), z: clean(z), rotationY, y: clean(levelY(floor)), ...extra,
      };
      furnishings.push(placement);
      for (const part of geometry.furnishingColliders(placement)) {
        const offset = geometry.rotateY(part.x || 0, part.z || 0, rotationY);
        box({ floor, group: 'furnishing', kind: 'furnishing', of: type, placementId: placement.id,
          material: null, x: x + offset.x, z: z + offset.z, localY: part.y,
          w: part.w, h: part.h, d: part.d, rotationY });
      }
      if (type === 'side-table-lamp') pointLight({ floor, x, z, localY: 1.19, color: 0x750000, intensity: 0.22, distance: 4.5 });
    }

    // Each level's master key hides in a drawer in the store the table marked. A drawer holds one key
    // and whoever searches it second finds it empty.
    for (const store of STORES.filter((entry) => entry.key)) {
      place('dresser', store.floor, store.floor === 1 ? 46 : 25, store.floor === 1 ? 6 : -24.5, 0, {
        keyId: keyIdForFloor(store.floor),
        keyLabel: keyLabelForFloor(store.floor),
        label: `${store.name.toLowerCase()} counter`,
      });
    }

    // Atrium and each tenancy are dressed with the reference's own furniture and clear aisles.
    place('fountain', 1, -7.3, 0);
    for (const [x, z] of [[-12.2, -5.8], [-12.2, 5.8]]) place('couch', 1, x, z, z < 0 ? 0 : Math.PI);
    for (const [x, z] of [[-2.7, -5.8], [-2.7, 5.8], [-15, -18], [15, -18], [-15, 17], [15, 17]]) place('plant', 1, x, z);
    for (const z of [-20, -12, -4, 4, 12, 20]) {
      place('rack', 1, -35, z, 0, { width: 5 });
      place('rack', 1, -29, z + 2.7, HALF_TURN, { width: 4 });
    }
    for (const z of [-23, -17, -11, -5, 1, 7]) wallX({ floor: 1, x: -41.25, z, width: 4.5, height: 2.5, material: 'dark' });
    splitWall({ floor: 1, axis: 'z', fixed: -39, from: -23, to: 7, height: 2.5, material: 'dark',
      openings: [-20, -14, -8, -2, 4].map(center => ({ center, width: 1.05, height: 2.15 })) });
    place('counter', 1, -30, 26, 0, { width: 7 });
    for (const [x, z] of [[-40, -25], [-30, -25], [-40, 27], [-28, 27]]) place('plant', 1, x, z);
    for (let x = -21; x <= -11; x += 2.4) {
      wallZ({ floor: 1, x, z: -29.3, depth: 5.2, height: 2.35, material: 'dark' });
      wallX({ floor: 1, x: x + 1.15, z: -31.8, width: 2.3, height: 2.35, material: 'dark' });
    }
    for (const [x, z] of [[11, -31], [17, -31], [11, -26], [17, -26]]) place('desk', 1, x, z, 0, { lamp: x === 11 });
    place('couch', 1, 21, -31, HALF_TURN); place('plant', 1, 21, -25);
    for (const x of [29, 35, 41]) for (const z of [-21, -15]) place('table', 1, x, z);
    place('shelf', 1, 44, -18, 0, { width: 1.1, height: 1.64, depth: 10, finish: 'metal' });
    for (let z = -22; z <= -14; z += 2.6) place('shelf', 1, 46, z, HALF_TURN, { width: 3.2, height: 1.8, depth: 0.55, finish: 'metal' });
    for (let z = -6; z <= 6; z += 3) for (const x of [34, 39, 44]) place('arcade', 1, x, z);
    // The entrance remains clear for 2m before the pharmacy gondolas start.
    for (let x = 22; x <= 33; x += 3.2) place('shelf', 1, x, 21.6, 0, { width: 1, height: 1.65, depth: 11.2, finish: 'dark' });
    place('counter', 1, 27.5, 27.7, 0, { width: 14, depth: 0.75 });
    for (const [x, z, scale] of [[40, 15, 1], [43, 16.5, 0.9], [46, 15, 1], [45.5, 17.2, 0.8]]) place('crate', 1, x, z, 0, { scale });
    for (const [x, z] of [[-41, -21], [-32, -21], [-41, -8], [-32, -8]]) place('display-bed', 2, x, z);
    for (const [x, z, r] of [[-41, 7, 0], [-32, 7, Math.PI], [-41, 18, 0], [-32, 18, Math.PI]]) place('couch', 2, x, z, r);
    for (const [x, z] of [[-44, 7], [-29, 7], [-44, 18], [-29, 18]]) place('side-table-lamp', 2, x, z);
    for (const z of [23, 25.5, 28]) place('shelf', 2, -31, z, 0, { width: 5, height: 1.7, finish: 'dark' });
    for (const z of [-31.5, -27.2]) for (const x of [-20, -11]) place('toy-display', 2, x, z, 0, { width: 3.6 });
    for (const x of [-20, -11]) place('plant', 2, x, -24.6);
    for (const x of [-3, 1.5, 6]) place('salon-station', 2, x, -29);
    place('couch', 2, 5, -25, HALF_TURN);
    for (const x of [12.5, 17, 22.5, 27]) place('bookcase', 2, x, -29, HALF_TURN, { width: 8.2, height: 1.95 });
    place('couch', 2, 12.5, -24.4); place('side-table-lamp', 2, 15.2, -24.4); place('plant', 2, 27, -24.5);
    place('counter', 2, 29.5, 16.2, 0, { width: 4.6 });
    for (const cx of [24.5, 33.5]) {
      for (const z of [22.3, 24.2, 26.1]) for (const dx of [-2.8, -1.4, 0, 1.4, 2.8]) place('cinema-seat', 2, cx + dx, z);
      place('cinema-screen', 2, cx, 30.5);
    }
    for (let x = 1; x <= 15; x += 4.4) for (const z of [24, 28, 32]) place('desk', 2, x, z, z === 28 ? Math.PI : 0, { lamp: x > 5 && x < 6 });
    place('couch', 2, 15, 33, HALF_TURN); place('plant', 2, -1, 33);

    // Practical lights down the concourse and the galleries.
    for (const def of floorDefs) {
      for (const [x, z] of [[0, -18], [-16, -12], [16, -12], [-16, 14], [16, 14], [-39, 0], [39, -3], [26, 20]]) {
        if (def.id === 2 && x > ATRIUM.minX && x < ATRIUM.maxX && z > ATRIUM.minZ && z < ATRIUM.maxZ) continue;
        box({ floor: def.id, kind: 'prop', material: 'redLight', collider: false, x, localY: 2.7, z, w: 0.7, h: 0.08, d: 0.28 });
        pointLight({ floor: def.id, x, z, localY: 2.6 });
      }
    }

    // --- navigation --------------------------------------------------------------------------------

    // The concourse ring, as waypoints. A mall is not a corridor with rooms off it, so there is no
    // spine to walk: the graph is the loop around the atrium, plus a spur to each shopfront. This is
    // the whole reason navigation moved into the plan — the hotel's answer here was a list of Z
    // values at x=0, which describes precisely one building.
    // A sparse visibility graph over authored aisles. Edges are accepted only when the same
    // body-sized collision and walk surfaces used by the simulation permit the entire segment.
    // This keeps a new gondola from silently turning an AI route into a wall.
    const navBoxes = [
      ...boxes.filter(entry => entry.collider).map(boxBounds),
      ...swingDoors.map(door => geometry.hingedBounds(door, door.openAngle)),
    ];
    const nodes = [], edges = [];
    const body = { radius: config.playerRadius + 0.02, bodyHeight: config.bodyHeight };
    const clearPoint = (floor, x, z) => {
      const y = levelY(floor);
      return !geometry.collidesAt(navBoxes, { ...body, x, z, feetY: y })
        && geometry.walkHeightAt(surfaces, x, z, y, config.groundSnap) === y;
    };
    function node(floor, x, z, id = `aisle-${floor}-${nodes.length}`) {
      if (!clearPoint(floor, x, z)) return;
      if (nodes.some(n => n.floor === floor && n.x === x && n.z === z)) return;
      nodes.push({ id, floor, x, z });
    }
    const concourse = [
      [0, -18], [-19, -18], [-19, 0], [-19, 16], [0, 16], [17, 16], [17, 0], [19, -18],
      [-23, -21], [-23, 10], [-23, 28], [-20, 32], [0, 32], [18, 32],
      [18, 10], [28, 10], [38.75, 10], [38.75, 19], [38.75, 22.4],
      [23.5, -22], [23.5, -25.3], [27, -25.3], [34, -25.3],
      [0, -30], [-6, -21], [8, -21], [26, -10], [28, 0], [39, 10],
      [-27, -24], [-27, -14], [-27, 0], [-27, 8], [-27, 18], [-27, 28],
      [-38, -24], [-38, 9], [-38, 27], [-45.5, -25], [-45.5, 28],
    ];
    for (const def of floorDefs) {
      for (const [x, z] of concourse) node(def.id, x, z);
      for (const room of roomCenters.filter(r => r.floor === def.id)) node(def.id, room.x, room.z, `room-${room.roomNumber}`);
    }
    for (const entry of storeEntries) {
      for (const distance of [-1, 0.8, 2.5]) node(entry.floor,
        entry.axis === 'x' ? entry.center : entry.fixed + entry.outward * distance,
        entry.axis === 'x' ? entry.fixed + entry.outward * distance : entry.center);
    }
    for (const [x, z] of [
      [-38, -8], [-41, -8], [-41, -9], [-45.5, -9], [-42, 18], [-45.5, 18],
      [-32, -24], [-32, -16], [-32, 0], [-32, 8], [-32, 16], [-38, 16],
      [26, -18], [32, -18], [38, -18], [32, -7.5], [36, -7.5], [41.5, -7.5],
      [32, 1.5], [36, 1.5], [41.5, 1.5], [46, 1.5], [46, 4.5],
      [25, 14], [20, 14.5], [23.6, 25], [26.8, 25], [30, 25], [33.2, 25],
      [20, 15.6], [23.6, 15.6], [26.8, 15.6], [30, 15.6], [33.2, 15.6],
      [37, 12], [37, 19], [43, 11], [43, 14.5],
    ]) node(1, x, z);
    for (const [x, z] of [
      [-37, -25], [-37, -14], [-37, 0], [-37, 12], [-37, 26],
      [-15.5, -33], [1, -32], [19.5, -33.5], [24.8, -33.5],
      [24.5, 18], [33.5, 18], [36.7, 18], [24.5, 20.5], [33.5, 20.5],
      [20.9, 20.5], [20.9, 28.5], [28.1, 20.5], [28.1, 28.5],
      [29.9, 20.5], [29.9, 28.5], [36.7, 20.5], [36.7, 28.5],
      [23, 29], [32, 29], [23, 33.5], [32, 33.5], [36.7, 33.5],
      [7, 22], [7, 26], [7, 30],
    ]) node(2, x, z);
    node(1, 2, 8.5, 'escalator-foot-1');
    node(2, 2, -12.5, 'escalator-head-2');
    const expanded = navBoxes.map(b => ({ ...b, minX: b.minX - body.radius, maxX: b.maxX + body.radius,
      minZ: b.minZ - body.radius, maxZ: b.maxZ + body.radius }));
    // A same-floor edge must never graze a ramp and snap up mid-route. Vertical travel belongs
    // exclusively to the connectors, even where the ground slab continues below an escalator.
    expanded.push(...surfaces.filter(s => s.kind === 'ramp').map(s => ({
      minX: s.minX - 0.02, maxX: s.maxX + 0.02, minZ: s.minZ - 0.02, maxZ: s.maxZ + 0.02,
      minY: -1, maxY: FLOOR_H + 2,
    })));
    for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
      const from = nodes[a], to = nodes[b];
      if (from.floor !== to.floor) continue;
      const distance = Math.hypot(to.x - from.x, to.z - from.z);
      if (distance > 32) continue;
      const y = levelY(from.floor);
      if (geometry.segmentBlocked(expanded, { x: from.x, y: y + 0.6, z: from.z },
        { x: to.x, y: y + 0.6, z: to.z }, { tolerance: 0 })) continue;
      let clear = true;
      for (let i = 0; i <= Math.ceil(distance / 0.3); i++) {
        const t = i / Math.ceil(distance / 0.3);
        if (!clearPoint(from.floor, from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t)) { clear = false; break; }
      }
      if (clear) edges.push([from.id, to.id]);
    }

    const navigation = {
      nodes,
      edges,
      connectors: [
        {
          id: 'service-stair', kind: 'stair', floors: floorDefs.map((def) => def.id),
          approach: { x: 38.75, z: STAIR.doorZ },
          layout: stairLayout, shell: stairShell,
        },
        // The escalators are a second way up, described as a stair so one router handles both. Its
        // single "flight" is the west deck, and its shell is the run the pair occupies.
        {
          id: 'escalators', kind: 'stair', floors: [1, 2],
          approach: { x: 2, z: 8.5 },
          approaches: { 1: { x: 2, z: 8.5 }, 2: { x: 2, z: -12.5 } },
          layout: {
            entrances: [
              { floor: 1, x: 2, z: 8.5, y: 0 },
              { floor: 2, x: 2, z: -12.5, y: clean(FLOOR_H) },
            ],
            landings: [],
            flights: [{
              transition: 1, lane: 'west',
              startX: ESCALATORS[0].x, startZ: ESCALATORS[0].startZ,
              endX: ESCALATORS[0].x, endZ: ESCALATORS[0].endZ,
              startY: 0, endY: clean(FLOOR_H), width: ESCALATORS[0].width, steps: 16, railSide: -1,
            }],
          },
          shell: { bounds: { xWest: 0.5, xEast: 6, zMin: -12, zMax: 8.5 } },
        },
      ],
      // Spread across the whole footprint, which is what lets three demons open apart on two levels.
      spawnNodes: [
        { floor: 1, x: -45.5, z: -25 }, { floor: 1, x: -45.5, z: 28 },
        { floor: 2, x: -45.5, z: -25 }, { floor: 2, x: 32, z: 29 },
      ],
      minSpawnSeparation: 26,
    };

    // --- spawns ------------------------------------------------------------------------------------

    // The seeker is held in the ground-floor cabin for the head start; the hiders scatter across both
    // levels, all of them onto places a body can actually stand.
    const spawns = {
      seeker: { floor: 1, x: LIFT.centerX, z: clean(LIFT.centerZ - 0.6), y: 0 },
      hiders: [
        { floor: 1, x: 0, z: -30, y: 0 },
        { floor: 1, x: -20, z: 0, y: 0 },
        { floor: 1, x: 20, z: 10, y: 0 },
        { floor: 1, x: -19, z: 28, y: 0 },
        { floor: 2, x: 0, z: -30, y: clean(FLOOR_H) },
        { floor: 2, x: -19, z: 0, y: clean(FLOOR_H) },
        { floor: 2, x: 30, z: 0, y: clean(FLOOR_H) },
        { floor: 2, x: -20, z: 25, y: clean(FLOOR_H) },
      ],
    };

    const colliders = boxes
      .filter((entry) => entry.collider)
      .map((entry) => ({ ...boxBounds(entry), id: entry.id || null, floor: entry.floor }));

    return {
      inspectionViews: {
        entrance: { x: 0, y: 1.62, z: -30, yaw: Math.PI, pitch: 0 },
        atrium: { x: 0, y: 1.62, z: -16, yaw: Math.PI, pitch: 0.08 },
        department: { x: -22, y: 1.62, z: -14, yaw: Math.PI / 2, pitch: 0 },
        food: { x: 21, y: 1.62, z: -18, yaw: -Math.PI / 2, pitch: 0 },
        upper: { x: 0, y: clean(FLOOR_H + 1.62), z: -18, yaw: Math.PI, pitch: 0 },
        cinema: { x: 24.5, y: clean(FLOOR_H + 1.62), z: 16.5, yaw: Math.PI, pitch: 0 },
        book: { x: 19.5, y: clean(FLOOR_H + 1.62), z: -21, yaw: 0, pitch: 0 },
        lift: { x: 34, y: 1.62, z: -25.3, yaw: 0, pitch: 0 },
      },
      elevator: {
        centerX: LIFT.centerX, centerZ: LIFT.centerZ, frontZ: LIFT.frontZ,
        halfWidth: LIFT.halfWidth, halfDepth: LIFT.halfDepth,
        floors: floorDefs.map((def) => def.id),
      },
      boxes, surfaces, colliders, swingDoors, slidingDoors,
      roomDoors, secretPanels, secretTunnels, roomCenters, furnishings, hallDoors,
      signs, doorFrames, wallLamps, lights, fixtures, stairs, spawns, navigation, storeEntries,
    };
  }

  return { ...geometry, FLOOR_DEFS, createMallPlan };
});
