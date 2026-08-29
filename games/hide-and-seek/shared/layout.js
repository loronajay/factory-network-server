(function attachHotelLayout(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelLayout = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelLayoutApi() {
  'use strict';

  function createStairLayout({ floorCount = 4, floorHeight = 4.6 } = {}) {
    const southZ = 44.15;
    const northZ = 52.35;
    const southRunZ = 44.7;
    const northRunZ = 51.8;
    const westX = 5.65;
    const eastX = 7.85;
    const landingX = 6.75;
    const stairWidth = 1.15;
    const landings = [];
    const flights = [];
    const entrances = [];

    for (let floor = 1; floor <= floorCount; floor += 1) {
      const y = (floor - 1) * floorHeight;
      entrances.push({ floor, x: 5.35, z: southZ, y });
      landings.push({ kind: 'floor', floor, x: landingX, z: southZ, y, w: 3.5, d: 1.55 });
    }

    for (let transition = 1; transition < floorCount; transition += 1) {
      const startY = (transition - 1) * floorHeight;
      const middleY = startY + floorHeight / 2;
      const endY = startY + floorHeight;
      landings.push({
        kind: 'switchback', transition, x: landingX, z: northZ,
        y: middleY, w: 3.5, d: 1.55,
      });
      flights.push({
        transition, lane: 'west', startX: westX, startZ: southRunZ,
        endX: westX, endZ: northRunZ, startY, endY: middleY,
        width: stairWidth, steps: 18, railSide: 1,
      });
      flights.push({
        transition, lane: 'east', startX: eastX, startZ: northRunZ,
        endX: eastX, endZ: southRunZ, startY: middleY, endY,
        width: stairWidth, steps: 18, railSide: -1,
      });
    }

    landings.sort((a, b) => a.y - b.y || (a.kind === 'floor' ? -1 : 1));
    return { entrances, landings, flights };
  }

  function createDoorFrameLayout({ x, z, width = 1.45, height = 2.12 } = {}) {
    const trimDepth = 0.12;
    const trimWidth = 0.16;
    const jambOffset = width / 2 + trimDepth / 2;
    return [
      { kind: 'jamb', x, y: height / 2, z: z - jambOffset, w: trimWidth, h: height, d: trimDepth },
      { kind: 'jamb', x, y: height / 2, z: z + jambOffset, w: trimWidth, h: height, d: trimDepth },
      { kind: 'header', x, y: height + trimDepth / 2, z, w: trimWidth, h: trimDepth, d: width + trimDepth * 2 },
    ];
  }

  function createStairwellShellLayout() {
    const xWest = 4.72;
    const xEast = 8.92;
    const zMin = 42;
    const zMax = 55.55;
    const landingZ = 44.15;
    const doorWidth = 1.7;
    const entranceMinZ = landingZ - doorWidth / 2;
    const entranceMaxZ = landingZ + doorWidth / 2;
    const serviceEdgeX = 4.6;
    const floorLandingMinX = 5;
    const threshold = {
      x: 5.25,
      z: landingZ,
      w: 1.5,
      d: 1.9,
      minX: 4.5,
      maxX: 6,
      minZ: landingZ - 0.95,
      maxZ: landingZ + 0.95,
    };

    return {
      bounds: { xWest, xEast, zMin, zMax },
      serviceEdgeX,
      serviceJunctionZ: 42.05,
      floorLandingMinX,
      entrance: {
        z: landingZ,
        width: doorWidth,
        minZ: entranceMinZ,
        maxZ: entranceMaxZ,
        lowPierDepth: entranceMinZ - zMin,
        highPierDepth: zMax - entranceMaxZ,
      },
      threshold,
      baseSlab: {
        x: (xWest + xEast) / 2,
        z: (zMin + zMax) / 2,
        w: xEast - xWest - 0.22,
        d: zMax - zMin - 0.22,
        minX: xWest + 0.11,
        maxX: xEast - 0.11,
        minZ: zMin + 0.11,
        maxZ: zMax - 0.11,
        walkable: true,
      },
      guards: [
        { edge: 'floor-south', x1: 6, z1: 43.28, x2: 8.55, z2: 43.28, height: 1.05 },
        { edge: 'floor-north', x1: 6, z1: 45.02, x2: 7.18, z2: 45.02, height: 1.05 },
        { edge: 'switchback-north', x1: 5, z1: 53.2, x2: 8.5, z2: 53.2, height: 1.05 },
      ],
    };
  }

  function getRoomFillLight(floorId) {
    return {
      color: 0xffddb0,
      intensity: floorId === 4 ? 0.36 : 0.42,
      emissiveIntensity: floorId === 4 ? 0.52 : 0.58,
      distance: 7.5,
      decay: 2,
      castShadow: false,
      strategy: 'emissive',
    };
  }

  function getHallLighting() {
    return {
      color: 0xb00000,
      intensity: 0.62,
      distance: 9,
      decay: 2,
      pointSpacing: 16,
      fixtureSpacing: 8,
      castShadow: false,
    };
  }

  // Which floors keep their lights in the realtime pass. On a floor this is just that floor, but the
  // stairwell and the moving elevator report floor 0, and lighting *every* floor there put ~32 point
  // lights in one pass — the stairwell framerate collapse. Vertical proximity is the honest rule:
  // from a stair flight you can only ever see into the floors it runs between.
  function selectVisibleLightFloors({ activeFloor = 1, feetY = 0, floorHeight = 4.6, floorCount = 4, radius = 0.9 } = {}) {
    if (activeFloor >= 1) return [activeFloor];
    const reach = floorHeight * radius;
    const near = [];
    for (let floor = 1; floor <= floorCount; floor += 1) {
      if (Math.abs(feetY - (floor - 1) * floorHeight) <= reach) near.push(floor);
    }
    if (near.length) return near;
    let closest = 1;
    let bestDiff = Infinity;
    for (let floor = 1; floor <= floorCount; floor += 1) {
      const diff = Math.abs(feetY - (floor - 1) * floorHeight);
      if (diff < bestDiff) { bestDiff = diff; closest = floor; }
    }
    return [closest];
  }

  function resolveWalkSurfaceHeight(surfaces, x, z, currentFeetY, groundSnap) {
    let best = null;
    let bestPriority = -Infinity;
    let bestDiff = Infinity;
    for (const surface of surfaces) {
      if (!surface.enabled() || x < surface.minX || x > surface.maxX || z < surface.minZ || z > surface.maxZ) continue;
      const y = surface.heightAt(x, z);
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

  return { createDoorFrameLayout, createStairLayout, createStairwellShellLayout, getHallLighting, getRoomFillLight, resolveWalkSurfaceHeight, selectVisibleLightFloors };
});
