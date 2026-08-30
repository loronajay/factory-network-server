(function attachHotelPlan(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelPlan = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelPlanApi(root) {
  'use strict';

  // The generic plan geometry now lives in `collision-logic.js`, because a mall cannot reasonably
  // ask a hotel where its own floor is. It is re-exported here so every `plan.resolveColliders(...)`
  // call site — the browser's, the tests', and the server's match engine — is unchanged.
  const geometry = typeof require === 'function' ? require('./collision-logic.js') : root.HotelCollision;
  const { boxBounds, hingedBounds, resolveColliders, rotateY, slidingBounds, walkHeightAt } = geometry;

  // The building, as data.
  //
  // Construction and rendering used to be the same pass: a wall became a mesh, and the mesh's world
  // matrix was where its collider came from. That made the hotel un-buildable outside a browser,
  // which is the one thing a server-authoritative round cannot live with — if only the client can
  // say where the walls are, only the client can say who was caught.
  //
  // So this module answers "what is the building" and nothing else. It emits plain boxes, walk
  // surfaces, doors and spawns in world space, with no renderer anywhere in the file. The browser
  // turns the same plan into meshes; a server ticks it directly.

  const HALF_TURN = Math.PI / 2;

  const clean = (value) => (Math.abs(value) < 1e-12 ? 0 : Number(value.toFixed(9)));

  function createHotelPlan({ config, floorDefs, layout, floorY, keyIdForFloor, keyLabelForFloor }) {
    const boxes = [];
    const surfaces = [];
    const roomDoors = [];
    const secretPanels = [];
    const secretTunnels = [];
    const roomCenters = [];
    const furnishings = [];
    const hallDoors = [];
    const signs = [];
    const doorFrames = [];
    const wallLamps = [];
    const lights = [];
    const fixtures = [];
    const swingDoors = [];
    const slidingDoors = [];

    // --- emitters -------------------------------------------------------------------------------
    // Everything below writes in a floor's local frame and is lifted to world space here, so the
    // authored numbers stay readable next to the original builders.

    function box(floor, baseY, spec) {
      boxes.push({ floor, group: spec.group || 'floor', material: spec.material, collider: !!spec.collider, localY: spec.y, ...spec, y: spec.y + baseY });
      return boxes[boxes.length - 1];
    }
    function wall(floor, baseY, x, z, w, d, h = 3.2, material = 'wall') {
      return box(floor, baseY, { kind: 'wall', x, y: h / 2, z, w, h, d, material, collider: true });
    }
    function slab(floor, baseY, x, z, w, d, material) {
      return box(floor, baseY, { kind: 'slab', x, y: -0.1, z, w, h: 0.2, d, material });
    }
    function ceiling(floor, baseY, x, z, w, d, height = 3.2) {
      return box(floor, baseY, { kind: 'ceiling', x, y: height, z, w, h: 0.14, d, material: 'ceiling' });
    }
    function groundRect(floor, baseY, x, z, w, d, localY = 0, priority = 0) {
      surfaces.push({ kind: 'rect', floor, minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, y: baseY + localY, priority });
    }
    function sign(floor, baseY, text, x, y, z, rotationY = 0, w = 1.3, h = 0.65) {
      signs.push({ floor, text, x, y: y + baseY, z, rotationY, w, h, localY: y });
    }
    function light(floor, baseY, spec) {
      lights.push({ floor, ...spec, y: spec.y + baseY, localY: spec.y });
    }

    // Furnishings are placements, not meshes: the renderer knows how to draw a bed, and this knows
    // where the beds are and which parts of one a body cannot walk through.
    // What each placement stops is shared plan geometry now, in `collision-logic.js`: the mall had
    // no such table at all, so its furniture was scenery. One table, both buildings.
    const furnishingColliders = geometry.furnishingColliders;

    // Every placement carries a stable id. A drawer is a contested object online — who searched it
    // and who got the key are answers the authority gives — so it has to be nameable without a mesh.
    function furnish(floor, baseY, type, x, z, rotationY = 0, extra = {}) {
      const placement = { id: `fx-${floor}-${furnishings.length}`, type, floor, x, z, rotationY, y: baseY, ...extra };
      furnishings.push(placement);
      for (const part of furnishingColliders(placement)) {
        const offset = rotateY(part.x || 0, part.z || 0, rotationY);
        boxes.push({
          kind: 'furnishing', floor, group: 'furnishing', of: type, collider: true, material: null,
          x: x + offset.x, y: baseY + part.y, z: z + offset.z, w: part.w, h: part.h, d: part.d, rotationY,
        });
      }
      return placement;
    }

    // --- rooms ----------------------------------------------------------------------------------

    function splitWallForOpening(floor, baseY, x, roomMinZ, roomMaxZ, openingZ, openingWidth, thickness = 0.22) {
      const lowEnd = openingZ - openingWidth / 2;
      const highStart = openingZ + openingWidth / 2;
      const lowDepth = Math.max(0, lowEnd - roomMinZ);
      const highDepth = Math.max(0, roomMaxZ - highStart);
      if (lowDepth > 0.05) wall(floor, baseY, x, roomMinZ + lowDepth / 2, thickness, lowDepth);
      if (highDepth > 0.05) wall(floor, baseY, x, highStart + highDepth / 2, thickness, highDepth);
    }

    function addRoomDoor(floor, baseY, { x, z, width = 1.45, side, roomNumber, locked, requiredKey, openInitially }) {
      const direction = side === 'left' ? -1 : 1;
      const door = {
        id: `door-${roomNumber}`, kind: 'room', roomNumber, floor, side, direction,
        x, z, width, locked, requiredKey, openInitially,
        // The hinge sits at the low-Z edge of the opening and the leaf hangs off it.
        hingeX: x, hingeZ: z - width / 2, y: baseY + 1.06,
        localX: 0, localZ: width / 2, w: 0.1, h: 2.12, d: width,
        openAngle: direction * HALF_TURN,
      };
      roomDoors.push(door);
      swingDoors.push(door);
      return door;
    }

    function addSecretPanel(floor, baseY, { x, z, width = 1.15, side, id }) {
      const direction = side === 'left' ? -1 : 1;
      const panel = {
        id, kind: 'secret', floor, side, direction, x, z, width,
        hingeX: x, hingeZ: z - width / 2, y: baseY + 1.025,
        localX: 0, localZ: width / 2, w: 0.11, h: 2.05, d: width,
        openAngle: direction * HALF_TURN,
        // Swung fully back the panel is flush with the wall it came out of.
        hideWhenOpen: true,
      };
      secretPanels.push(panel);
      swingDoors.push(panel);
      return panel;
    }

    function addRoom(def, baseY, roomNumber, centerX, centerZ, side, floorMat) {
      const floor = def.id;
      const roomMinX = centerX - 4;
      const roomMaxX = centerX + 4;
      const roomMinZ = centerZ - 4;
      const roomMaxZ = centerZ + 4;
      const isSecret = def.secretRooms.includes(roomNumber);
      const secretZ = centerZ - 2.35;

      slab(floor, baseY, centerX, centerZ, 8, 8, floorMat);
      groundRect(floor, baseY, centerX, centerZ, 8, 8);
      ceiling(floor, baseY, centerX, centerZ, 8, 8);
      wall(floor, baseY, centerX, roomMinZ, 8, 0.22);
      wall(floor, baseY, centerX, roomMaxZ, 8, 0.22);

      const outerX = side === 'left' ? roomMinX : roomMaxX;
      const innerX = side === 'left' ? roomMaxX : roomMinX;
      const inward = side === 'left' ? -1 : 1;

      if (isSecret) {
        splitWallForOpening(floor, baseY, outerX, roomMinZ, roomMaxZ, secretZ, 1.15);
        addSecretPanel(floor, baseY, { x: outerX - inward * 0.04, z: secretZ, side, id: `${roomNumber}-secret` });
      } else {
        wall(floor, baseY, outerX, centerZ, 0.22, 8);
      }
      splitWallForOpening(floor, baseY, innerX, roomMinZ, roomMaxZ, centerZ, 1.45);
      sign(floor, baseY, roomNumber, innerX + inward * 0.13, 2.15, centerZ - 1.35, side === 'left' ? -HALF_TURN : HALF_TURN, 1.05, 0.52);
      doorFrames.push({ floor, x: innerX + inward * 0.12, z: centerZ, width: 1.45, height: 2.12, material: 'wood', localY: 0, y: baseY });
      const roomDoor = addRoomDoor(floor, baseY, {
        x: innerX + inward * 0.05, z: centerZ, side, roomNumber,
        locked: def.lockedRooms.includes(roomNumber),
        requiredKey: keyIdForFloor(def.id),
        openInitially: def.openRooms.includes(roomNumber),
      });

      const fillSpec = layout.getRoomFillLight(def.id);
      fixtures.push({ kind: 'room-fill', floor, roomNumber, doorId: roomDoor.id, x: centerX, y: baseY + 3.08, localY: 3.08, z: centerZ, w: 0.72, h: 0.06, d: 0.42, spec: fillSpec });

      const variant = def.roomVariants[roomNumber] || 'standard';
      const outward = side === 'left' ? -1 : 1;
      const keyId = def.keyPlacements[roomNumber] || null;
      const keyLabel = keyLabelForFloor(def.id);
      if (variant === 'standard') {
        furnish(floor, baseY, 'bed', centerX + outward * 1.95, centerZ - 0.2, side === 'left' ? HALF_TURN : -HALF_TURN);
        furnish(floor, baseY, 'desk', centerX - outward * 1.55, centerZ + 3.02, 0, { lamp: true });
        furnish(floor, baseY, 'dresser', centerX, centerZ - 3.02, Math.PI, { keyId, keyLabel });
        furnish(floor, baseY, 'plant', centerX + outward * 2.7, centerZ + 2.35, 0, { scale: 1 });
      } else if (variant === 'suite') {
        furnish(floor, baseY, 'couch', centerX, centerZ + 1.15, Math.PI);
        furnish(floor, baseY, 'bed', centerX + outward * 1.95, centerZ - 1.25, side === 'left' ? HALF_TURN : -HALF_TURN);
        furnish(floor, baseY, 'desk', centerX - outward * 1.45, centerZ + 3.02, 0, { lamp: true });
        furnish(floor, baseY, 'dresser', centerX - 0.15 * outward, centerZ - 3.02, Math.PI, { keyId, keyLabel });
        furnish(floor, baseY, 'plant', centerX - outward * 2.65, centerZ + 0.65, 0, { scale: 0.95 });
      } else {
        box(floor, baseY, { kind: 'prop', x: centerX, y: 1, z: centerZ - 2.85, w: 5, h: 2, d: 0.55, material: 'dark', collider: true });
        box(floor, baseY, { kind: 'prop', x: centerX + outward * 2.6, y: 0.62, z: centerZ + 2.75, w: 1, h: 1.24, d: 0.75, material: 'metal', collider: true });
        furnish(floor, baseY, 'dresser', centerX - outward * 1.65, centerZ + 3.02, 0, { keyId, keyLabel, label: 'tool drawer' });
      }

      roomCenters.push({ roomNumber, floor: def.id, x: centerX, z: centerZ, side });
    }

    function addSecretTunnel(def, baseY, roomA, roomB) {
      const a = roomCenters.find((entry) => entry.roomNumber === roomA);
      const b = roomCenters.find((entry) => entry.roomNumber === roomB);
      if (!a || !b || a.side !== b.side) return;
      const floor = def.id;
      const x = a.side === 'left' ? -13.25 : 13.25;
      const panelZA = a.z - 2.35;
      const panelZB = b.z - 2.35;
      const minZ = Math.min(panelZA, panelZB) - 1.05;
      const maxZ = Math.max(panelZA, panelZB) + 1.05;
      const depth = maxZ - minZ;
      const centerZ = (minZ + maxZ) / 2;
      const material = def.id === 4 ? 'floor4' : 'dark';

      slab(floor, baseY, x, centerZ, 2.55, depth, material);
      groundRect(floor, baseY, x, centerZ, 2.55, depth);
      ceiling(floor, baseY, x, centerZ, 2.55, depth, 2.55);
      // Published so the sanity meter can tell a passage from a corridor: a tunnel drains the meter.
      secretTunnels.push({ id: `${roomA}-${roomB}-tunnel`, kind: 'tunnel', floor: def.id, minX: x - 1.275, maxX: x + 1.275, minZ, maxZ });

      wall(floor, baseY, a.side === 'left' ? -14.5 : 14.5, centerZ, 0.18, depth, 2.55, 'dark');
      wall(floor, baseY, x, minZ, 2.55, 0.18, 2.55, 'dark');
      wall(floor, baseY, x, maxZ, 2.55, 0.18, 2.55, 'dark');
      const gapStart = Math.min(a.z, b.z) + 4;
      const gapEnd = Math.max(a.z, b.z) - 4;
      if (gapEnd > gapStart) wall(floor, baseY, a.side === 'left' ? -12.03 : 12.03, (gapStart + gapEnd) / 2, 0.18, gapEnd - gapStart, 2.55, 'dark');
      light(floor, baseY, { kind: 'point', color: 0x9b1d1d, intensity: 0.45, distance: 7, decay: 2, x, y: 2.05, z: centerZ });
      fixtures.push({ kind: 'tunnel-lamp', floor, x, y: baseY + 2.4, localY: 2.4, z: centerZ, w: 0.45, h: 0.08, d: 0.18, material: 'redLight' });
    }

    // --- the shell ------------------------------------------------------------------------------

    function addStairwellShell(def, baseY, shell) {
      const floor = def.id;
      const { xWest, xEast, zMin, zMax } = shell.bounds;
      const entrance = shell.entrance;
      const height = config.floorHeight;

      wall(floor, baseY, xWest, zMin + entrance.lowPierDepth / 2, 0.22, entrance.lowPierDepth, height);
      wall(floor, baseY, xWest, entrance.maxZ + entrance.highPierDepth / 2, 0.22, entrance.highPierDepth, height);
      box(floor, baseY, { kind: 'wall', x: xWest, y: 3.42, z: entrance.z, w: 0.22, h: 2.36, d: entrance.width, material: 'wall', collider: true });
      wall(floor, baseY, xEast, (zMin + zMax) / 2, 0.22, zMax - zMin, height);
      wall(floor, baseY, (xWest + xEast) / 2, zMin, xEast - xWest, 0.22, height);
      wall(floor, baseY, (xWest + xEast) / 2, zMax, xEast - xWest, 0.22, height);
      sign(floor, baseY, 'STAIRS', xWest - 0.13, 2.35, entrance.z - 1.22, HALF_TURN, 1.1, 0.42);
      doorFrames.push({ floor, x: xWest - 0.13, z: entrance.z, width: entrance.width, height: 2.24, material: 'brass', localY: 0, y: baseY });

      const threshold = shell.threshold;
      box(floor, baseY, { kind: 'slab', x: threshold.x, y: -0.06, z: threshold.z, w: threshold.w, h: 0.12, d: threshold.d, material: 'wood' });
      groundRect(floor, baseY, threshold.x, threshold.z, threshold.w, threshold.d);
      if (def.id === 1) {
        const base = shell.baseSlab;
        box(floor, baseY, { kind: 'slab', x: base.x, y: -0.06, z: base.z, w: base.w, h: 0.12, d: base.d, material: 'wood' });
        groundRect(floor, baseY, base.x, base.z, base.w, base.d);
      }
      if (def.id === 4) ceiling(floor, baseY, (xWest + xEast) / 2, (zMin + zMax) / 2, xEast - xWest, zMax - zMin, 4.42);
      light(floor, baseY, { kind: 'point', color: 0x8e0000, intensity: 0.62, distance: 8, decay: 2, x: 6.75, y: 2.7, z: 48.9 });
    }

    function addElevatorHall(def, baseY) {
      const floor = def.id;
      const wallZ = config.elevatorFrontZ;
      const center = config.elevatorCenterX;
      const leftEdge = center - 1.05;
      const rightEdge = center + 1.05;

      wall(floor, baseY, -9 + (leftEdge + 9) / 2, wallZ, leftEdge + 9, 0.22);
      wall(floor, baseY, rightEdge + (9 - rightEdge) / 2, wallZ, 9 - rightEdge, 0.22);
      box(floor, baseY, { kind: 'wall', x: center, y: 2.78, z: wallZ, w: 2.1, h: 0.84, d: 0.22, material: 'wall', collider: true });
      box(floor, baseY, { kind: 'trim', x: leftEdge - 0.08, y: 1.3, z: wallZ, w: 0.16, h: 2.6, d: 0.28, material: 'brass' });
      box(floor, baseY, { kind: 'trim', x: rightEdge + 0.08, y: 1.3, z: wallZ, w: 0.16, h: 2.6, d: 0.28, material: 'brass' });
      sign(floor, baseY, `FLOOR ${def.id}`, center, 2.72, wallZ - 0.13, 0, 1.25, 0.42);

      for (const side of ['left', 'right']) {
        const direction = side === 'left' ? -1 : 1;
        hallDoors.push({
          id: `hall-door-${def.id}-${side}`, kind: 'hall', floor: def.id, side, direction,
          centerX: center, x: center + direction * 0.46, y: baseY + 1.175, z: wallZ - 0.08,
          w: 0.92, h: 2.35, d: 0.08,
        });
      }
      for (const door of hallDoors.filter((entry) => entry.floor === def.id)) slidingDoors.push(door);
      box(floor, baseY, { kind: 'call-button', x: rightEdge + 0.44, y: 1.25, z: wallZ - 0.215, w: 0.11, h: 0.18, d: 0.04, material: 'brass', callFloor: def.id });
    }

    function buildFloor(def, shell) {
      const floor = def.id;
      const baseY = floorY(def.id);
      const floorMat = `floor${def.id}`;

      // Corridor.
      slab(floor, baseY, 0, 0, 8, 84, floorMat);
      groundRect(floor, baseY, 0, 0, 8, 84);
      ceiling(floor, baseY, 0, 0, 8, 84);
      for (const [z, d] of [[-38, 8], [-25, 2], [-15, 2], [-5, 2], [5, 2], [15, 2], [25, 2], [38, 8]]) {
        wall(floor, baseY, -4.1, z, 0.22, d);
        wall(floor, baseY, 4.1, z, 0.22, d);
      }

      // Lobby end.
      slab(floor, baseY, 0, -51, 18, 18, floorMat);
      groundRect(floor, baseY, 0, -51, 18, 18);
      ceiling(floor, baseY, 0, -51, 18, 18);
      wall(floor, baseY, -9.1, -51, 0.22, 18);
      wall(floor, baseY, 9.1, -51, 0.22, 18);
      wall(floor, baseY, 0, -60.1, 18.2, 0.22);
      wall(floor, baseY, -6.55, -42.05, 5, 0.22);
      wall(floor, baseY, 6.55, -42.05, 5, 0.22);

      // Service end, in front of the elevator and the stairs.
      const serviceDepth = config.elevatorFrontZ - 42;
      const serviceCenterZ = 42 + serviceDepth / 2;
      const serviceWidth = 13.6;
      slab(floor, baseY, -2.2, serviceCenterZ, serviceWidth, serviceDepth, floorMat);
      groundRect(floor, baseY, -2.2, serviceCenterZ, serviceWidth, serviceDepth);
      ceiling(floor, baseY, -2.2, serviceCenterZ, serviceWidth, serviceDepth);
      wall(floor, baseY, -9.1, serviceCenterZ, 0.22, serviceDepth);
      wall(floor, baseY, 9.1, serviceCenterZ, 0.22, serviceDepth);
      wall(floor, baseY, -6.55, 42.05, 5, 0.22);
      wall(floor, baseY, 4.3, 42.05, 0.6, 0.22);

      [30, 20, 10, 0, -10, -20, -30].forEach((z, i) => {
        addRoom(def, baseY, `${def.id}${String(i * 2 + 1).padStart(2, '0')}`, -8, z, 'left', floorMat);
        addRoom(def, baseY, `${def.id}${String(i * 2 + 2).padStart(2, '0')}`, 8, z, 'right', floorMat);
      });
      for (const link of def.secretLinks) addSecretTunnel(def, baseY, link[0], link[1]);

      if (def.id === 1) {
        box(floor, baseY, { kind: 'prop', x: 0, y: 0.65, z: -56.2, w: 6, h: 1.3, d: 1, material: 'wood', collider: true });
        sign(floor, baseY, 'CHECK-IN', 0, 2.05, -56.75, 0, 2.2, 1.1);
        furnish(floor, baseY, 'couch', -4.7, -49.2, HALF_TURN);
        furnish(floor, baseY, 'couch', 4.7, -49.2, -HALF_TURN);
        furnish(floor, baseY, 'plant', -7.1, -58, 0, { scale: 1.3 });
        furnish(floor, baseY, 'plant', 7.1, -58, 0, { scale: 1.3 });
      } else if (def.id === 2) {
        furnish(floor, baseY, 'couch', -3.4, -51.4, 0);
        furnish(floor, baseY, 'couch', 3.4, -51.4, 0);
        furnish(floor, baseY, 'plant', -7, -56.8, 0, { scale: 1.25 });
        furnish(floor, baseY, 'plant', 7, -56.8, 0, { scale: 1.25 });
      } else if (def.id === 3) {
        furnish(floor, baseY, 'couch', 0, -52.8, 0);
        furnish(floor, baseY, 'plant', -6.7, -57, 0, { scale: 1.2 });
        furnish(floor, baseY, 'plant', 6.7, -57, 0, { scale: 1.2 });
      } else {
        furnish(floor, baseY, 'plant', 6.8, -57, 0, { scale: 1 });
      }

      furnish(floor, baseY, 'vending', -8.54, 49.35, -HALF_TURN, { color: def.id === 4 ? 0x55534c : def.id === 3 ? 0x5b3a69 : 0x7b2f33 });
      furnish(floor, baseY, 'vending', -8.54, 51.05, -HALF_TURN, { color: def.id === 2 ? 0x2f6d4d : 0x334a73 });
      addElevatorHall(def, baseY);
      addStairwellShell(def, baseY, shell);

      const hallLighting = layout.getHallLighting();
      for (let z = -35; z <= 35; z += hallLighting.fixtureSpacing) {
        wallLamps.push({ floor, x: -3.88, y: baseY + 2, localY: 2, z, rotationY: -HALF_TURN });
        wallLamps.push({ floor, x: 3.88, y: baseY + 2, localY: 2, z, rotationY: HALF_TURN });
      }
      for (let z = -32; z <= 32; z += hallLighting.pointSpacing) {
        light(floor, baseY, { kind: 'point', color: hallLighting.color, intensity: hallLighting.intensity, distance: hallLighting.distance, decay: hallLighting.decay, x: 0, y: 2.35, z });
      }
      light(floor, baseY, { kind: 'point', color: 0x8e0000, intensity: 0.62, distance: 9, decay: 2, x: 0, y: 2.6, z: 50.2 });
    }

    // --- the stairwell --------------------------------------------------------------------------
    // World space and shared by every floor, because the whole point is that it is one shaft with no
    // swapping and no teleports.

    const stairs = { treads: [], rails: [] };

    function rail(start, end) {
      stairs.rails.push({ start, end });
    }
    function guardRail(guard, y) {
      const start = { x: guard.x1, y: y + guard.height, z: guard.z1 };
      const end = { x: guard.x2, y: y + guard.height, z: guard.z2 };
      rail(start, end);
      rail({ ...start, y }, start);
      rail({ ...end, y }, end);
    }

    function buildStairwell(shell) {
      const stairLayout = layout.createStairLayout({ floorCount: floorDefs.length, floorHeight: config.floorHeight });

      for (const landing of stairLayout.landings) {
        stairs.treads.push({ x: landing.x, y: landing.y - 0.07, z: landing.z, w: landing.w, h: 0.14, d: landing.d, rotationY: 0 });
        surfaces.push({
          kind: 'rect', floor: 0, priority: 0,
          minX: landing.x - landing.w / 2, maxX: landing.x + landing.w / 2,
          minZ: landing.z - landing.d / 2, maxZ: landing.z + landing.d / 2,
          y: landing.y,
        });
        if (landing.kind === 'switchback') guardRail(shell.guards.find((guard) => guard.edge === 'switchback-north'), landing.y);
      }
      for (const def of floorDefs) {
        for (const guard of shell.guards.filter((item) => item.edge.startsWith('floor-'))) guardRail(guard, floorY(def.id));
      }

      for (const flight of stairLayout.flights) {
        const dx = flight.endX - flight.startX;
        const dz = flight.endZ - flight.startZ;
        const length = Math.hypot(dx, dz);
        const rotation = Math.atan2(dx, dz);
        const run = length / flight.steps;
        for (let i = 0; i < flight.steps; i += 1) {
          const t = (i + 0.5) / flight.steps;
          const topT = (i + 1) / flight.steps;
          stairs.treads.push({
            x: flight.startX + dx * t,
            y: flight.startY + (flight.endY - flight.startY) * topT - 0.075,
            z: flight.startZ + dz * t,
            w: flight.width, h: 0.15, d: run + 0.035, rotationY: rotation,
          });
        }
        // A flight is a ramp, not a stack of little rectangles: the walk surface is what a body
        // actually rides, and it must win over the landing it overlaps.
        surfaces.push({
          kind: 'ramp', floor: 0, priority: 1,
          minX: flight.startX - flight.width / 2, maxX: flight.startX + flight.width / 2,
          minZ: Math.min(flight.startZ, flight.endZ), maxZ: Math.max(flight.startZ, flight.endZ),
          startZ: flight.startZ, endZ: flight.endZ, startY: flight.startY, endY: flight.endY,
        });
        const xOffset = flight.railSide * (flight.width / 2 + 0.045);
        const start = { x: flight.startX + xOffset, y: flight.startY + 0.86, z: flight.startZ };
        const end = { x: flight.endX + xOffset, y: flight.endY + 0.86, z: flight.endZ };
        rail(start, end);
        rail({ ...start, y: start.y - 0.86 }, start);
        rail({ ...end, y: end.y - 0.86 }, end);
      }
    }

    // The corridor spine, as a graph. One node per hall stop per floor, linked to its neighbours
    // along Z, and one vertical connector: the stairwell every demon uses and no elevator.
    function createNavigation(shell) {
      const SPINE_Z = [-52, -34, -18, 0, 18, 34, 49];
      const nodes = [];
      const edges = [];
      for (const def of floorDefs) {
        let previous = null;
        for (const z of SPINE_Z) {
          const id = `hall-${def.id}-${z}`;
          nodes.push({ id, floor: def.id, x: 0, z });
          if (previous) edges.push([previous, id]);
          previous = id;
        }
      }
      const stairLayout = layout.createStairLayout({ floorCount: floorDefs.length, floorHeight: config.floorHeight });
      return {
        // This older spine graph has no room-entry nodes. Preserve its explicit bedroom doglegs;
        // maps with complete aisle/door graphs use the navigator directly.
        corridorSweep: { roomThreshold: 4.25, doorwayX: 3.75 },
        nodes,
        edges,
        connectors: [{
          id: 'stairwell',
          kind: 'stair',
          floors: floorDefs.map((def) => def.id),
          // The hall point a demon walks to before it enters the stair door. This was `(0, 42.8)`
          // hard-coded inside `enemy-logic.createStairRoute`.
          approach: { x: 0, z: 42.8 },
          layout: stairLayout,
          shell,
        }],
        // Where a round may open a demon. Kept off the spine's exact stops so three demons in a
        // two-floor building still read as three separate bodies.
        spawnNodes: floorDefs.flatMap((def) => [-52, -28, 0, 28, 49].map((z) => ({ floor: def.id, x: 0, z }))),
        minSpawnSeparation: 24,
      };
    }

    // --- assembly -------------------------------------------------------------------------------

    const shell = layout.createStairwellShellLayout();
    for (const def of floorDefs) buildFloor(def, shell);
    buildStairwell(shell);

    // How a demon gets around this building.
    //
    // Where a demon may walk used to be spelled as constants inside `demon-logic.js` — a corridor
    // spine at x=0, a list of patrol Z values, and a dogleg that stepped out to |x|=3.75 whenever a
    // target sat off the spine. Every one of those numbers is *this hotel's floorplan*, so a second
    // building could not be navigated at all without a per-map branch in the AI.
    //
    // So circulation is part of the plan now, in the one shape both buildings can answer in: a
    // waypoint graph per floor, plus the vertical connectors between floors. The hotel's graph is
    // its corridor spine, which is why routing through it lands where the old dogleg did — a room
    // off the hall is reached by walking the spine to the room's Z and stepping out. A building
    // shaped like a ring rather than a corridor simply emits a ring.
    const navigation = createNavigation(shell);

    // The elevator car is the one walkable surface whose height is state rather than geometry.
    surfaces.push({
      kind: 'dynamic', id: 'elevator-car', floor: 0, priority: 0,
      minX: config.elevatorCenterX - 1.16, maxX: config.elevatorCenterX + 1.16,
      minZ: config.elevatorFrontZ - 0.12, maxZ: config.elevatorCenterZ + 1.47,
    });

    // Where a round starts. The seeker is held in the lobby cabin; hiders scatter to the corridor
    // ends and the lobby, all of them places a body can actually stand.
    const spawns = {
      seeker: { floor: 1, x: config.elevatorCenterX, z: config.elevatorCenterZ, y: floorY(1) },
      hiders: [],
    };
    for (const def of floorDefs) {
      for (const z of [-34, -12, 12, 34]) spawns.hiders.push({ floor: def.id, x: 0, z, y: floorY(def.id) });
    }

    const colliders = boxes
      .filter((entry) => entry.collider)
      .map((entry) => ({ ...boxBounds(entry), id: entry.id || null, floor: entry.floor }));

    return {
      // Where this building's lift is. It used to be five constants in `modules/game-config.js`
      // read directly by the fixtures, the tick, the renderer and the elevator module — which is
      // fine while there is one building and wrong the moment there are two, because a mall's lift
      // is not in a hotel's lobby. The plan owns its own shaft now.
      elevator: {
        centerX: config.elevatorCenterX, centerZ: config.elevatorCenterZ, frontZ: config.elevatorFrontZ,
        halfWidth: config.elevatorHalfWidth, halfDepth: config.elevatorHalfDepth,
        floors: floorDefs.map((def) => def.id),
      },
      boxes, surfaces, colliders, swingDoors, slidingDoors,
      roomDoors, secretPanels, secretTunnels, roomCenters, furnishings, hallDoors,
      signs, doorFrames, wallLamps, lights, fixtures, stairs, spawns, navigation,
    };
  }

  return { boxBounds, createHotelPlan, hingedBounds, resolveColliders, slidingBounds, walkHeightAt };
});
