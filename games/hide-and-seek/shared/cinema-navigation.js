(function attachCinemaNavigation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CinemaNavigation = api;
})(typeof window !== 'undefined' ? window : globalThis, function createCinemaNavigationApi() {
  'use strict';

  // Cinema topology, shared by every CPU role and the authority. Door crossings stay square;
  // cross-halls use the gaps between auditoriums, never diagonal links through their walls.
  function createCinemaNavigation({ auditoriums, booths, stairLayouts, rooms }) {
    const nodes = [], edges = [];
    function node(id, floor, x, z) { nodes.push({ id, floor, x, z }); return id; }
    function edge(a, b) { edges.push([a, b]); }
    function chain(prefix, floor, x, zs) {
      const sorted = [...new Set(zs)].sort((a, b) => a - b);
      sorted.forEach((z, i) => {
        node(`${prefix}:${z}`, floor, x, z);
        if (i) edge(`${prefix}:${sorted[i - 1]}`, `${prefix}:${z}`);
      });
    }
    chain('hall', 1, 0, [-44, -34, -16, 1, 23, 47, ...auditoriums.map(a => a.entryZ)]);
    for (const side of [-1, 1]) {
      const prefix = `service:${side}`;
      chain(prefix, 1, side * 59, [-44, -20, 1, 23, 47, ...auditoriums.map(a => a.serviceExitZ)]);
      const lobby = node(`lobby:${side}`, 1, side * 18, -44);
      edge('hall:-44', lobby); edge(lobby, `${prefix}:-44`);
      for (const z of [1, 23, 47]) edge(`hall:${z}`, `${prefix}:${z}`);
      edge(node(`stair-bottom:${side}`, 1, side * 14, -41), 'hall:-44');
    }
    for (const aud of auditoriums) {
      const side = aud.side === 'west' ? -1 : 1;
      const centerZ = (aud.seatMinZ + aud.seatMaxZ) / 2;
      const points = [
        ['door', side * 14, aud.entryZ], ['vestibule', side * 20.1, aud.entryZ],
        ['sound-lock', side * 20.1, aud.seatMinZ + 0.8], ['rear', side * 20.1, centerZ],
        ['center', side * 32, centerZ], ['front', side * 50, centerZ],
        ['exit-aisle', side * 50, aud.serviceExitZ], ['service', side * 59, aud.serviceExitZ],
      ];
      let previous = `hall:${aud.entryZ}`;
      for (const [label, x, z] of points) {
        const id = node(`${aud.id}:${label}`, 1, x, z);
        edge(previous, id); previous = id;
      }
      edge(previous, `service:${side}:${aud.serviceExitZ}`);
    }
    chain('projection', 2, 0, [-16.8, ...booths.map(b => b.entryZ), 44]);
    for (const booth of booths) {
      const side = booth.side === 'west' ? -1 : 1;
      const approach = node(`${booth.id}:door`, 2, side * 8, booth.entryZ);
      const inside = node(`${booth.id}:inside`, 2, side * 14, booth.entryZ);
      const room = rooms.find(r => r.roomNumber === booth.id);
      const target = node(`${booth.id}:target`, 2, room.x, room.z);
      edge(`projection:${booth.entryZ}`, approach); edge(approach, inside); edge(inside, target);
    }
    for (const side of [-1, 1]) edge(node(`stair-top:${side}`, 2, side * 14, -16.8), 'projection:-16.8');

    // The lift's upper landing is a side wing, not a replacement for either CPU stair route.
    for (const floor of [1, 2]) {
      const exit = node(`lift-exit:${floor}`, floor, 42, -40);
      if (floor === 1) {
        edge(exit, node('lift-lobby', 1, 42, -44));
        edge('lift-lobby', 'service:1:-44');
      } else {
        edge(exit, node('landing-south', 2, 24, -40));
        edge('landing-south', node('landing-north', 2, 24, -16.8));
        edge('landing-north', 'projection:-16.8');
      }
    }
    // Lobby restroom and locked film store are real searchable rooms, not signs on empty space.
    edge('service:1:-20', node('store-approach', 1, 50, -24.5));
    edge('store-approach', node('store-target', 1, 44, -24.5));
    edge('lobby:1', node('restroom-hall', 1, 18, -32));
    edge('restroom-hall', node('restroom-approach', 1, 18, -24.5));
    edge('restroom-approach', node('restroom-target', 1, 25, -24.5));

    return {
      nodes, edges, minSpawnSeparation: 24,
      connectors: stairLayouts.map(({ spec, layout }) => ({
        id: spec.id, kind: 'stair', floors: [1, 2],
        approach: { x: spec.x, z: spec.startZ - 1 },
        approaches: { 1: { x: spec.x, z: spec.startZ - 1 }, 2: { x: spec.x, z: spec.endZ + 1.2 } },
        layout, shell: { bounds: { xWest: spec.minX, xEast: spec.maxX, zMin: spec.startZ - 2, zMax: spec.endZ + 2 } },
      })),
      spawnNodes: [{ floor: 1, x: -59, z: 47 }, { floor: 1, x: 59, z: 47 },
        { floor: 2, x: 0, z: 44 }, { floor: 2, x: 24, z: -40 }],
    };
  }
  return { createCinemaNavigation };
});
