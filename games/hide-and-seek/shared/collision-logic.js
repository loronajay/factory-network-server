(function attachHotelCollision(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelCollision = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelCollisionApi() {
  'use strict';

  const clean = (value) => Math.abs(value) < 1e-12 ? 0 : Number(value.toFixed(12));

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

  return { collidesAt, createBoxCollider, segmentBlocked };
});
