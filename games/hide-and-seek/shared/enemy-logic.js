(function attachHotelEnemyLogic(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelEnemyLogic = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelEnemyLogicApi() {
  'use strict';

  const ENEMY_STATES = Object.freeze({ ROAM: 'roam', CHASE: 'chase', SEARCH: 'search' });

  function aggregateEnemyState(states = []) {
    if (states.some((entry) => entry?.state === ENEMY_STATES.CHASE)) return ENEMY_STATES.CHASE;
    if (states.some((entry) => entry?.state === ENEMY_STATES.SEARCH)) return ENEMY_STATES.SEARCH;
    if (states.some((entry) => entry?.routePurpose === 'hunt')) return 'hunt';
    return ENEMY_STATES.ROAM;
  }

  function planarDistance(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
  }

  function chooseSpawn(spawns, player, random = Math.random, minimumDistance = 20, excludedFloors = []) {
    if (!spawns.length) return null;
    const allowed = spawns.filter((spawn) => !excludedFloors.includes(spawn.floor));
    const available = allowed.length ? allowed : spawns;
    const safe = available.filter((spawn) => spawn.floor !== player.floor || planarDistance(spawn, player) >= minimumDistance);
    const pool = safe.length ? safe : available;
    return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  }

  function canDetectPlayer({ enemy, player, occluded, maxDistance = 18, fieldOfView = Math.PI * 0.72 }) {
    if (occluded || Math.abs(enemy.y - player.y) > 2.75) return false;
    const dx = player.x - enemy.x;
    const dz = player.z - enemy.z;
    const distance = Math.hypot(dx, dz);
    const effectiveRange = maxDistance * (player.crouching ? 0.55 : 1);
    if (distance > effectiveRange) return false;
    if (distance < 2.6) return true;
    const facingLength = Math.hypot(enemy.facingX, enemy.facingZ) || 1;
    const dot = (dx * enemy.facingX + dz * enemy.facingZ) / (distance * facingLength || 1);
    return dot >= Math.cos(fieldOfView / 2);
  }

  function selectDetectedTarget(candidates, enemy, { isOccluded = () => false, maxDistance, fieldOfView } = {}) {
    let nearest = null;
    let nearestDistance = Infinity;
    for (const player of candidates || []) {
      if (!player || !canDetectPlayer({ enemy, player, occluded: isOccluded(player), maxDistance, fieldOfView })) continue;
      const distance = planarDistance(enemy, player);
      if (distance < nearestDistance) { nearest = player; nearestDistance = distance; }
    }
    return nearest;
  }

  function createAwareness() {
    return { state: ENEMY_STATES.ROAM, lastSeen: null, searchRemaining: 0, targetId: null, pursuitRemaining: 0, clueActive: false };
  }

  function createStairRoute({ fromFloor, toFloor, floorHeight, stairLayout }) {
    if (fromFloor === toFloor) return [];
    const point = (x, y, z, floor, guided = true, stair = true) => {
      const result = { x, y, z, floor, guided };
      if (stair) result.stair = true;
      return result;
    };
    const floorY = (floor) => (floor - 1) * floorHeight;
    const route = [point(0, floorY(fromFloor), 42.8, fromFloor, false, false)];
    const entranceFor = (floor) => stairLayout.entrances.find((entry) => entry.floor === floor);
    const addEntrance = (floor) => {
      const entrance = entranceFor(floor);
      route.push(point(entrance.x, entrance.y, entrance.z, floor));
    };
    addEntrance(fromFloor);

    let floor = fromFloor;
    while (floor !== toFloor) {
      const goingUp = toFloor > floor;
      const transition = goingUp ? floor : floor - 1;
      const west = stairLayout.flights.find((flight) => flight.transition === transition && flight.lane === 'west');
      const east = stairLayout.flights.find((flight) => flight.transition === transition && flight.lane === 'east');
      if (goingUp) {
        route.push(
          point(west.startX, west.startY, west.startZ, floor),
          point(west.endX, west.endY, west.endZ, floor),
          point(east.startX, east.startY, east.startZ, floor + 1),
          point(east.endX, east.endY, east.endZ, floor + 1),
        );
        floor += 1;
      } else {
        route.push(
          point(east.endX, east.endY, east.endZ, floor),
          point(east.startX, east.startY, east.startZ, floor - 1),
          point(west.endX, west.endY, west.endZ, floor - 1),
          point(west.startX, west.startY, west.startZ, floor - 1),
        );
        floor -= 1;
      }
    }

    addEntrance(toFloor);
    route.push(point(0, floorY(toFloor), 42.8, toFloor, false, false));
    return route;
  }

  function stairSpine(stairLayout) {
    const nodes = [];
    const entranceFor = (floor) => stairLayout.entrances.find((entry) => entry.floor === floor);
    const add = (point, floor) => nodes.push({ x: point.x, y: point.y, z: point.z, floor });
    const firstFloor = Math.min(...stairLayout.entrances.map((entry) => entry.floor));
    add(entranceFor(firstFloor), firstFloor);
    const transitions = [...new Set(stairLayout.flights.map((flight) => flight.transition))].sort((a, b) => a - b);
    for (const transition of transitions) {
      const west = stairLayout.flights.find((flight) => flight.transition === transition && flight.lane === 'west');
      const east = stairLayout.flights.find((flight) => flight.transition === transition && flight.lane === 'east');
      add({ x: west.startX, y: west.startY, z: west.startZ }, transition);
      add({ x: west.endX, y: west.endY, z: west.endZ }, transition);
      add({ x: east.startX, y: east.startY, z: east.startZ }, transition + 1);
      add({ x: east.endX, y: east.endY, z: east.endZ }, transition + 1);
      add(entranceFor(transition + 1), transition + 1);
    }
    return nodes;
  }

  function projectToSpine(point, nodes) {
    let best = null;
    for (let index = 0; index < nodes.length - 1; index += 1) {
      const a = nodes[index]; const b = nodes[index + 1];
      const vx = b.x - a.x; const vy = b.y - a.y; const vz = b.z - a.z;
      const lengthSquared = vx * vx + vy * vy + vz * vz || 1;
      const t = Math.max(0, Math.min(1, ((point.x - a.x) * vx + (point.y - a.y) * vy + (point.z - a.z) * vz) / lengthSquared));
      const x = a.x + vx * t; const y = a.y + vy * t; const z = a.z + vz * t;
      const distanceSquared = (point.x - x) ** 2 + (point.y - y) ** 2 + (point.z - z) ** 2;
      if (!best || distanceSquared < best.distanceSquared) best = { x, y, z, progress: index + t, distanceSquared };
    }
    return best;
  }

  // A player can be halfway up a flight while the rest of the game quite correctly reports floor 0.
  // Route along the stair's centreline in that case instead of rounding the player to a floor and
  // steering at them through the shaft wall. The same route works when the demon is already inside.
  function createStairPursuitRoute({ enemy, target, floorHeight, stairLayout }) {
    const nodes = stairSpine(stairLayout);
    const targetProjection = projectToSpine(target, nodes);
    const floorOf = (y) => Math.max(1, Math.min(stairLayout.entrances.length, Math.round(y / floorHeight) + 1));
    const guidedPoint = (point) => ({ x: point.x, y: point.y, z: point.z, floor: floorOf(point.y), guided: true, stair: true });
    const route = [];
    const pushUnique = (point) => {
      const previous = route.at(-1);
      if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y, previous.z - point.z) > 0.025) route.push(point);
    };

    let startProgress;
    if (enemy.inStairwell) {
      const enemyProjection = projectToSpine(enemy, nodes);
      startProgress = enemyProjection.progress;
      pushUnique(guidedPoint(enemyProjection));
    } else {
      const entryFloor = enemy.floor || floorOf(enemy.y);
      const entrance = stairLayout.entrances.find((entry) => entry.floor === entryFloor);
      const entryIndex = nodes.findIndex((node) => node.floor === entryFloor && node.x === entrance.x && node.y === entrance.y && node.z === entrance.z);
      route.push({ x: 0, y: entrance.y, z: entrance.z, floor: entryFloor, guided: false });
      pushUnique({ x: entrance.x, y: entrance.y, z: entrance.z, floor: entryFloor, guided: true, stair: true });
      startProgress = entryIndex;
    }

    if (targetProjection.progress >= startProgress) {
      for (let index = Math.floor(startProgress) + 1; index <= Math.floor(targetProjection.progress); index += 1) pushUnique(guidedPoint(nodes[index]));
    } else {
      for (let index = Math.ceil(startProgress) - 1; index >= Math.ceil(targetProjection.progress); index -= 1) pushUnique(guidedPoint(nodes[index]));
    }
    pushUnique(guidedPoint(targetProjection));
    pushUnique(guidedPoint(target));
    return route;
  }

  function chooseRoamTarget({ hallTargets = [], roomTargets = [], roomChance = 0.22 } = {}, random = Math.random) {
    const visitRoom = roomTargets.length > 0 && random() < roomChance;
    const pool = visitRoom ? roomTargets : hallTargets;
    if (!pool.length) return null;
    const target = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
    return { ...target, room: visitRoom };
  }

  function prepareHuntDoor(door, openAngle = Math.PI / 2) {
    if (!door) return false;
    door.locked = false;
    door.open = true;
    door.target = (door.side === 'left' ? -1 : 1) * openAngle;
    return true;
  }

  function prepareRoamDoor(door, openAngle = Math.PI / 2) {
    if (!door || door.locked) return false;
    door.open = true;
    door.target = (door.side === 'left' ? -1 : 1) * openAngle;
    return true;
  }

  function updateAwareness(previous, {
    seesPlayer,
    delta,
    playerPosition = null,
    playerId = null,
    pursuitClue = null,
    searchDuration = 9,
    pursuitDuration = 5.5,
  }) {
    const next = { ...previous, lastSeen: previous.lastSeen ? { ...previous.lastSeen } : null };
    next.clueActive = false;
    if (seesPlayer) {
      next.state = ENEMY_STATES.CHASE;
      next.lastSeen = playerPosition ? { ...playerPosition } : next.lastSeen;
      next.searchRemaining = searchDuration;
      next.targetId = playerId || next.targetId;
      next.pursuitRemaining = pursuitDuration;
      return next;
    }
    if (next.state === ENEMY_STATES.CHASE) next.state = ENEMY_STATES.SEARCH;
    if (next.state === ENEMY_STATES.SEARCH) {
      next.pursuitRemaining = Math.max(0, (next.pursuitRemaining || 0) - delta);
      if (next.pursuitRemaining > 0 && pursuitClue && pursuitClue.id === next.targetId) {
        const { id: _id, ...position } = pursuitClue;
        next.lastSeen = position;
        next.clueActive = true;
      }
      next.searchRemaining -= delta;
      if (next.searchRemaining <= 0) {
        next.state = ENEMY_STATES.ROAM;
        next.lastSeen = null;
        next.searchRemaining = 0;
        next.targetId = null;
        next.pursuitRemaining = 0;
        next.clueActive = false;
      }
    }
    return next;
  }

  return { ENEMY_STATES, aggregateEnemyState, canDetectPlayer, chooseRoamTarget, chooseSpawn, createAwareness, createStairPursuitRoute, createStairRoute, planarDistance, prepareHuntDoor, prepareRoamDoor, selectDetectedTarget, updateAwareness };
});
