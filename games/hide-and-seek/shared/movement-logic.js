(function attachHotelMovement(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelMovement = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelMovementApi() {
  'use strict';

  // Every body in the hotel walks through this file: the local player, both demons and every hider.
  // There is no THREE in here on purpose — moving a body is a rule, and a server has to be able to
  // run it. A caller supplies a `space` ({ groundAt, blocked }) and gets plain numbers back.
  //
  //   space.groundAt(x, z, fromY) -> the feet height at that spot, or null for "nothing to stand on"
  //   space.blocked(x, z, feetY, height, radius) -> true if the body would be inside something
  //
  // `groundAt` returning null and `blocked` returning true are deliberately different answers. The
  // first is a ledge, the second is a wall, and only the second is worth sliding along.

  const DEFAULT_ARRIVE_RADIUS = 0.2;

  function attemptStep(space, body, from, x, z) {
    const ground = space.groundAt(x, z, from.y);
    if (ground === null || ground === undefined || !Number.isFinite(ground)) return null;
    if (space.blocked(x, z, ground, body.height, body.radius)) return null;
    return { x, y: ground, z };
  }

  // The local player's mover: the two axes are tried separately so a body pressed against a wall
  // keeps the component that is still free rather than stopping dead in the corridor.
  function stepAxes(space, body, from, dx, dz) {
    let position = { x: from.x, y: from.y, z: from.z };
    let moved = false;
    if (dx) {
      const next = attemptStep(space, body, position, position.x + dx, position.z);
      if (next) { position = next; moved = true; }
    }
    if (dz) {
      const next = attemptStep(space, body, position, position.x, position.z + dz);
      if (next) { position = next; moved = true; }
    }
    return { ...position, moved };
  }

  // The mover for anything following a route: demons and hiders. It takes the direct step, then the
  // two perpendicular ones, so a body catching a door frame slips past it instead of grinding.
  function stepToward(space, body, from, target, { speed = 0, delta = 0, arriveRadius = DEFAULT_ARRIVE_RADIUS, guided = false } = {}) {
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const dz = target.z - from.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < arriveRadius || distance === 0) {
      return { x: target.x, y: target.y, z: target.z, moved: false, arrived: true, blocked: false, dirX: 0, dirY: 0, dirZ: 0 };
    }
    const dirX = dx / distance; const dirY = dy / distance; const dirZ = dz / distance;
    const amount = Math.min(distance, speed * delta);
    const facing = { dirX, dirY, dirZ, arrived: false };
    if (!amount) return { x: from.x, y: from.y, z: from.z, moved: false, blocked: false, ...facing };
    // Stair flights and the elevator carry a body along a path the walk surfaces cannot describe, so
    // a guided waypoint is followed literally — including its vertical component.
    if (guided) {
      return { x: from.x + dirX * amount, y: from.y + dirY * amount, z: from.z + dirZ * amount, moved: true, blocked: false, ...facing };
    }
    const direct = attemptStep(space, body, from, from.x + dirX * amount, from.z + dirZ * amount);
    if (direct) return { ...direct, moved: true, blocked: false, ...facing };
    for (const side of [-1, 1]) {
      const slid = attemptStep(space, body, from, from.x + dirZ * side * amount, from.z - dirX * side * amount);
      if (slid) return { ...slid, moved: true, blocked: false, ...facing };
    }
    return { x: from.x, y: from.y, z: from.z, moved: false, blocked: true, ...facing };
  }

  return { stepAxes, stepToward, DEFAULT_ARRIVE_RADIUS };
});
