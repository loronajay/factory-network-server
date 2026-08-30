(function attachHotelCollision(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelCollision = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelCollisionApi() {
  'use strict';

  const clean = (value) => Math.abs(value) < 1e-12 ? 0 : Number(value.toFixed(12));

  // --- plan geometry ----------------------------------------------------------------------------
  //
  // Turning a plan's records into bounds: a box's footprint, a leaf carried round its hinge, a lift
  // door part-way open, the collider set for a given set of openings, and the height of whatever a
  // body is standing on.
  //
  // None of it is a hotel, but all of it lived in `hotel-plan.js` while the hotel was the only
  // building. A second map cannot borrow the first map's module to find out where its own floor is,
  // so the geometry moved here — where the AABB maths already was — and both plan modules re-export
  // it so every existing `plan.resolveColliders(...)` call site keeps working.

  const planClean = (value) => (Math.abs(value) < 1e-12 ? 0 : Number(Number(value).toFixed(9)));

  // A point in a group's local frame, rotated into world space. THREE's Y rotation is the reference
  // because the renderer has to land in the same place this does.
  function rotateY(x, z, angle) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return { x: x * cosine + z * sine, z: -x * sine + z * cosine };
  }

  // Axis-aligned bounds of a box that may be turned about Y. The footprint grows as it rotates,
  // which is close enough for a body that is itself a circle.
  function boxBounds({ x = 0, y = 0, z = 0, w, h, d, rotationY = 0 }) {
    const cosine = Math.abs(Math.cos(rotationY));
    const sine = Math.abs(Math.sin(rotationY));
    const halfX = (cosine * w + sine * d) / 2;
    const halfZ = (sine * w + cosine * d) / 2;
    return {
      minX: planClean(x - halfX), maxX: planClean(x + halfX),
      minY: planClean(y - h / 2), maxY: planClean(y + h / 2),
      minZ: planClean(z - halfZ), maxZ: planClean(z + halfZ),
    };
  }

  // A door swings about a hinge that is not its own centre, so the centre has to be carried round
  // the arc before the bounds are taken.
  function hingedBounds(door, angle = 0) {
    const offset = rotateY(door.localX, door.localZ, angle);
    return boxBounds({
      x: door.hingeX + offset.x, y: door.y, z: door.hingeZ + offset.z,
      w: door.w, h: door.h, d: door.d, rotationY: angle,
    });
  }

  // Elevator doors slide apart instead of swinging. `amount` is 0 shut, 1 fully open.
  function slidingBounds(door, amount = 0) {
    const travel = 0.46 + (1.72 - 0.46) * amount;
    return boxBounds({ x: door.centerX + door.direction * travel, y: door.y, z: door.z, w: door.w, h: door.h, d: door.d });
  }

  function walkHeightAt(surfaces, x, z, currentFeetY, groundSnap, dynamic = {}) {
    let best = null;
    let bestPriority = -Infinity;
    let bestDiff = Infinity;
    for (const surface of surfaces) {
      if (x < surface.minX || x > surface.maxX || z < surface.minZ || z > surface.maxZ) continue;
      let y;
      if (surface.kind === 'ramp') {
        const span = surface.endZ - surface.startZ;
        const t = span === 0 ? 0 : Math.max(0, Math.min(1, (z - surface.startZ) / span));
        y = surface.startY + (surface.endY - surface.startY) * t;
      } else if (surface.kind === 'dynamic') {
        const height = dynamic[surface.id];
        if (typeof height !== 'number') continue;
        y = height;
      } else {
        y = surface.y;
      }
      const diff = Math.abs(y - currentFeetY);
      const priority = surface.priority || 0;
      if (diff <= groundSnap && (priority > bestPriority || (priority === bestPriority && diff < bestDiff))) {
        best = y;
        bestPriority = priority;
        bestDiff = diff;
      }
    }
    return best;
  }

  // The collision list for one instant. `openings` maps a door id to its swing angle (room doors and
  // secret panels) or its open amount (elevator doors); anything absent is treated as shut.
  function resolveColliders(plan, openings = {}) {
    const resolved = plan.colliders.slice();
    for (const door of plan.swingDoors) {
      const angle = openings[door.id] || 0;
      // A panel folded flat into the wall has stopped being an obstacle.
      if (door.hideWhenOpen && Math.abs(angle) >= 1.25) continue;
      resolved.push(hingedBounds(door, angle));
    }
    for (const door of plan.slidingDoors) {
      const amount = openings[door.id] || 0;
      if (amount >= 0.62) continue;
      resolved.push(slidingBounds(door, amount));
    }
    return resolved;
  }


  // A renderer may turn this data into a mesh, but movement needs only these six numbers. Keeping
  // the authoritative shape plain lets the same test run in Node and, later, on the game server.
  function createBoxCollider({ x = 0, y = 0, z = 0, width, height, depth, rotationY = 0 } = {}) {
    const cosine = Math.abs(Math.cos(rotationY));
    const sine = Math.abs(Math.sin(rotationY));
    const halfX = (cosine * width + sine * depth) / 2;
    const halfZ = (sine * width + cosine * depth) / 2;
    return {
      minX: clean(x - halfX), maxX: clean(x + halfX),
      minY: clean(y - height / 2), maxY: clean(y + height / 2),
      minZ: clean(z - halfZ), maxZ: clean(z + halfZ),
    };
  }

  function collidesAt(colliders, { x, z, feetY, bodyHeight, radius } = {}) {
    const playerMinY = feetY + 0.06;
    const playerMaxY = feetY + bodyHeight;
    for (const box of colliders || []) {
      if (!box || box.enabled === false) continue;
      if (playerMaxY <= box.minY + 0.015 || playerMinY >= box.maxY - 0.015) continue;
      if (x > box.minX - radius && x < box.maxX + radius && z > box.minZ - radius && z < box.maxZ + radius) return true;
    }
    return false;
  }


  // Line of sight, as a slab-method ray against the same plain boxes movement uses. This replaces a
  // THREE.Raycaster in the demon: whether a wall is between two bodies is a rule, and the server has
  // to be able to answer it with no renderer in the process.
  function rayBoxDistance(box, origin, dirX, dirY, dirZ, maxDistance) {
    let near = 0;
    let far = maxDistance;
    const axes = [
      [origin.x, dirX, box.minX, box.maxX],
      [origin.y, dirY, box.minY, box.maxY],
      [origin.z, dirZ, box.minZ, box.maxZ],
    ];
    for (const [start, direction, min, max] of axes) {
      if (Math.abs(direction) < 1e-9) {
        if (start < min || start > max) return null;
        continue;
      }
      const inverse = 1 / direction;
      let entry = (min - start) * inverse;
      let exit = (max - start) * inverse;
      if (entry > exit) { const swap = entry; entry = exit; exit = swap; }
      if (entry > near) near = entry;
      if (exit < far) far = exit;
      if (near > far) return null;
    }
    return near;
  }

  // `tolerance` trims both ends of the segment: a hit right at the target is the furniture the target
  // is standing behind rather than something hiding them, and a hit at the origin is the body itself.
  function segmentBlocked(colliders, from, to, { tolerance = 0.18 } = {}) {
    const dx = to.x - from.x; const dy = to.y - from.y; const dz = to.z - from.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance <= tolerance) return false;
    const dirX = dx / distance; const dirY = dy / distance; const dirZ = dz / distance;
    for (const box of colliders || []) {
      if (!box || box.enabled === false) continue;
      const hit = rayBoxDistance(box, from, dirX, dirY, dirZ, distance);
      if (hit === null) continue;
      if (hit > tolerance && hit < distance - tolerance) return true;
    }
    return false;
  }

  // --- what a piece of furniture stops -----------------------------------------------------------
  //
  // A placement is a type and a position; these are the boxes that type occupies, in the placement's
  // own frame, and a plan rotates them into world space when it emits them. It lives here rather
  // than in a plan module for the reason everything else here does: the mall's `place()` had no such
  // table at all, so every desk, rack and cinema seat in Cinder Mall was scenery a body walked
  // straight through. One table, read by both buildings.
  //
  // An empty list is a real answer — a planter is dressed low enough to walk over the edge of, and
  // making it solid only snags a fleeing hider on a pot.
  const FURNISHING_COLLIDERS = Object.freeze({
    // hotel
    bed: [{ y: 0.3, w: 2.1, h: 0.45, d: 3.2 }, { y: 0.67, w: 2, h: 0.25, d: 3 }],
    desk: [{ y: 0.85, w: 1.6, h: 0.1, d: 0.7 }],
    couch: [
      { y: 0.35, w: 2, h: 0.45, d: 0.9 },
      { y: 0.75, z: -0.34, w: 2, h: 0.7, d: 0.22 },
      { x: -0.9, y: 0.52, w: 0.2, h: 0.62, d: 0.9 },
      { x: 0.9, y: 0.52, w: 0.2, h: 0.62, d: 0.9 },
    ],
    dresser: [{ y: 0.45, w: 1.35, h: 0.9, d: 0.58 }],
    vending: [{ y: 1.1, w: 1.1, h: 2.2, d: 0.9 }],
    plant: [],
    // mall. Sizes that carry a `width` on the placement are emitted by the plan instead, because a
    // 8.2m bookcase and a 3m one cannot share a fixed box.
    table: [{ y: 0.4, w: 1.55, h: 0.85, d: 1.55 },
      ...[[1.05, 0], [-1.05, 0], [0, 1.05], [0, -1.05]].map(([x, z]) => ({ x, z, y: 0.4, w: 0.68, h: 0.8, d: 0.68 }))],
    'cinema-seat': [{ y: 0.67, w: 0.86, h: 1.34, d: 0.84 }],
    'display-bed': [{ y: 0.45, w: 2.05, h: 0.9, d: 3 }],
    arcade: [{ y: 0.93, w: 1, h: 1.85, d: 0.9 }],
    crate: [{ y: 0.58, w: 1.15, h: 1.15, d: 1.15 }],
    'side-table-lamp': [{ y: 0.28, w: 0.7, h: 0.56, d: 0.7 }],
    'salon-station': [{ y: 0.45, w: 0.75, h: 0.9, d: 0.75 }],
    'cinema-screen': [],
    bookcase: [],
    shelf: [],
    rack: [],
    'toy-display': [],
    counter: [],
    fountain: [{ y: 0.375, w: 7.6, h: 0.75, d: 7.6 }],
  });

  // The boxes one placement occupies in world space. `sized` types read their footprint off the
  // placement itself, so one entry covers every length of gondola a shop is dressed with.
  const SIZED_FURNISHINGS = Object.freeze({
    crate: (p) => [{ y: (p.scale || 1.15) / 2, w: p.scale || 1.15, h: p.scale || 1.15, d: p.scale || 1.15 }],
    bookcase: (p) => [{ y: (p.height || 1.95) / 2, w: p.width || 8.2, h: p.height || 1.95, d: 0.48 }],
    shelf: (p) => [{ y: (p.height || 1.8) / 2, w: p.width || 3, h: p.height || 1.8, d: p.depth || 0.65 }],
    rack: (p) => [{ y: 0.78, w: p.width || 3, h: 1.56, d: 0.6 }],
    'toy-display': (p) => [{ y: 0.46, w: p.width || 3.2, h: 0.92, d: 0.8 }],
    counter: (p) => [{ y: 0.69, w: (p.width || 4) + 0.14, h: 1.38, d: (p.depth || 1) + 0.14 }],
  });

  function furnishingColliders(placement) {
    if (!placement) return [];
    const sized = SIZED_FURNISHINGS[placement.type];
    if (sized) return sized(placement);
    return FURNISHING_COLLIDERS[placement.type] || [];
  }

  // --- the lift's facing ------------------------------------------------------------------------
  //
  // Which way a cabin opens is the building's business, not the engine's. While the hotel was the
  // only map its doors always faced -Z, so `frontZ < centerZ` got written into the occupancy tests,
  // the cabin colliders and the hall-door placement as a bare minus sign. A second building put its
  // lift in a lobby that opens the other way, and a lift whose doors open into its own shaft is not
  // a tuning problem.
  //
  // `elevatorFacing` reads the sign off the plan's own two numbers, and `cabinOffset` projects a
  // world Z into the cabin's own axis: 0 at the centre line, positive toward the doors. Every test
  // that used to compare raw Z now compares an offset, so both orientations read identically.
  function elevatorFacing(shaft) {
    if (!shaft) return -1;
    const front = Number(shaft.frontZ);
    const center = Number(shaft.centerZ);
    if (!Number.isFinite(front) || !Number.isFinite(center) || front === center) return -1;
    return front > center ? 1 : -1;
  }

  // How far `z` sits toward the doors from the cabin's centre line, in metres.
  function cabinOffset(z, shaft) {
    return (z - Number(shaft.centerZ)) * elevatorFacing(shaft);
  }

  // Is a body standing in the cabin, looked at from above? `frontMargin` is how far past the door
  // line still counts (a body in the doorway is aboard) and `backMargin` how far behind the centre.
  function inCabinFootprint(position, shaft, { halfWidth = 1.12, frontMargin = 0.12, backMargin = 1.46 } = {}) {
    if (!shaft || !position) return false;
    if (Math.abs(position.x - Number(shaft.centerX)) >= halfWidth) return false;
    const offset = cabinOffset(position.z, shaft);
    const frontOffset = Math.abs(Number(shaft.frontZ) - Number(shaft.centerZ));
    return offset > -backMargin && offset < frontOffset + frontMargin;
  }

  return {
    collidesAt, createBoxCollider, segmentBlocked,
    elevatorFacing, cabinOffset, inCabinFootprint,
    FURNISHING_COLLIDERS, furnishingColliders,
    // Shared plan geometry, re-exported by every plan module so `sim-logic.createPlanSpace` can be
    // handed any map's plan and still find the helpers it needs.
    boxBounds, hingedBounds, resolveColliders, rotateY, slidingBounds, walkHeightAt,
  };
});
