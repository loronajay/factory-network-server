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
  function stepToward(space, body, from, target, {
    speed = 0, delta = 0, arriveRadius = DEFAULT_ARRIVE_RADIUS, guided = false, avoidance = null,
  } = {}) {
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const dz = target.z - from.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < arriveRadius || distance === 0) {
      const landing = guided
        ? (!space.blocked(target.x, target.z, target.y, body.height, body.radius) ? target : null)
        : attemptStep(space, body, from, target.x, target.z);
      if (landing) return { x: landing.x, y: landing.y, z: landing.z, moved: false, arrived: true, blocked: false, avoidance: null, dirX: 0, dirY: 0, dirZ: 0 };
      if (distance === 0) return { ...from, moved: false, arrived: false, blocked: true, avoidance: null, dirX: 0, dirY: 0, dirZ: 0 };
    }
    const dirX = dx / distance; const dirY = dy / distance; const dirZ = dz / distance;
    const amount = Math.min(distance, speed * delta);
    const facing = { dirX, dirY, dirZ, arrived: false };
    if (!amount) return { x: from.x, y: from.y, z: from.z, moved: false, blocked: false, avoidance, ...facing };
    // Guidance supplies the stair altitude, never permission to pass through solid geometry.
    if (guided) {
      const next = { x: from.x + dirX * amount, y: from.y + dirY * amount, z: from.z + dirZ * amount };
      if (space.blocked(next.x, next.z, next.y, body.height, body.radius)) {
        return { x: from.x, y: from.y, z: from.z, moved: false, blocked: true, avoidance: null, ...facing };
      }
      return { ...next, moved: true, blocked: false, avoidance: null, ...facing };
    }
    const direct = attemptStep(space, body, from, from.x + dirX * amount, from.z + dirZ * amount);
    if (direct) return { ...direct, moved: true, blocked: false, avoidance: null, ...facing };

    // Keep the same world-space tangent while following an obstacle. Recalculating a perpendicular
    // from the target every tick makes the tangent reverse as soon as the body passes the target's
    // centreline, which is the classic "running into the wall" oscillation.
    const tryAvoidance = (direction) => {
      if (!direction || !Number.isFinite(direction.x) || !Number.isFinite(direction.z)) return null;
      const length = Math.hypot(direction.x, direction.z);
      if (length < 0.01) return null;
      const avoidX = direction.x / length; const avoidZ = direction.z / length;
      const position = attemptStep(space, body, from, from.x + avoidX * amount, from.z + avoidZ * amount);
      return position ? {
        ...position,
        moved: true,
        blocked: false,
        avoidance: { x: avoidX, z: avoidZ },
        dirX: avoidX,
        dirY: 0,
        dirZ: avoidZ,
        arrived: false,
      } : null;
    };
    const continuing = tryAvoidance(avoidance);
    if (continuing) return continuing;
    if (avoidance) {
      const reversed = tryAvoidance({ x: -avoidance.x, z: -avoidance.z });
      if (reversed) return reversed;
    }
    for (const side of [-1, 1]) {
      const slid = tryAvoidance({ x: dirZ * side, z: -dirX * side });
      if (slid) return slid;
    }
    return { x: from.x, y: from.y, z: from.z, moved: false, blocked: true, avoidance: null, ...facing };
  }

  return { stepAxes, stepToward, DEFAULT_ARRIVE_RADIUS };
});
