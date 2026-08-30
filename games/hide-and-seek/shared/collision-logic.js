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

  return {
    collidesAt, createBoxCollider, segmentBlocked,
    // Shared plan geometry, re-exported by every plan module so `sim-logic.createPlanSpace` can be
    // handed any map's plan and still find the helpers it needs.
    boxBounds, hingedBounds, resolveColliders, rotateY, slidingBounds, walkHeightAt,
  };
});
