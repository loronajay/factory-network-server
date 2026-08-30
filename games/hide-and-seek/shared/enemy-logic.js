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

  // --- navigating a building --------------------------------------------------------------------

  // A demon's route across one floor, over the waypoint graph its map published.
  //
  // The hotel used to be navigated by arithmetic: walk to x=0, run along Z, and step out to |x|=3.75
  // if the target sat off the spine. That is a corridor's floorplan written as code, and it is why
  // the AI could not be pointed at a second building. The graph says the same thing as data — the
  // hotel emits its spine, a mall emits the ring around its atrium — and the router below is the
  // only thing that has to understand either.
  //
  // An empty graph routes to nothing on purpose. A single open room genuinely has no waypoints, and
  // "walk straight at it" is the correct answer there rather than a thrown error inside a tick.
  //
  // `space` is optional and is what makes joining the graph honest rather than merely near: a body
  // enters the graph at the closest waypoint it can actually walk straight to. Without it the
  // nearest waypoint by distance can be one on the other side of a wall � the doorway of the shop
  // next door, the hall stop across a storefront � and the first leg of every route is then a line
  // through that wall. Callers that have a world pass it; a pure graph test need not.
  function createNavigator(navigation, { space = null } = {}) {
    const nodes = (navigation && navigation.nodes) || [];
    const edges = (navigation && navigation.edges) || [];
    const connectors = (navigation && navigation.connectors) || [];

    const byId = new Map(nodes.map((node) => [node.id, node]));
    const neighbours = new Map(nodes.map((node) => [node.id, []]));
    for (const [a, b] of edges) {
      if (!byId.has(a) || !byId.has(b)) continue;
      neighbours.get(a).push(b);
      neighbours.get(b).push(a);
    }

    const cost = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

    // Nodes on one floor, nearest first. Sorting rather than scanning for a single minimum is what
    // lets the reachability filter below fall through to the second-nearest waypoint.
    function nodesByDistance(point, floor) {
      return nodes
        .filter((node) => node.floor === floor)
        .map((node) => ({ node, distance: cost(node, point) }))
        .sort((a, b) => a.distance - b.distance)
        .map((entry) => entry.node);
    }

    function reachable(point, node, y) {
      if (!space || !space.sightBlocked) return true;
      const eye = (Number.isFinite(y) ? y : (Number.isFinite(point.y) ? point.y : 0)) + 1;
      return !space.sightBlocked({ x: point.x, y: eye, z: point.z }, { x: node.x, y: eye, z: node.z }, { tolerance: 0.2 });
    }

    // The nearest waypoint the body could walk straight to, falling back to the nearest one of all
    // when the body is somewhere no waypoint can see � wedged in a corner, mid-doorway � because a
    // route to a waypoint it has to squeeze towards still beats no route at all.
    function nearestNode(point, floor, { y = null } = {}) {
      const candidates = nodesByDistance(point, floor);
      if (!candidates.length) return null;
      for (const node of candidates) if (reachable(point, node, y)) return node;
      return candidates[0];
    }

    // Dijkstra. The graphs are a few dozen nodes per floor, so the simple version is the right one —
    // a priority queue here would be more code than the search it accelerates.
    function shortestPath(startId, goalId) {
      if (startId === goalId) return [startId];
      const distances = new Map([[startId, 0]]);
      const previous = new Map();
      const unvisited = new Set(nodes.filter((node) => node.floor === byId.get(startId).floor).map((node) => node.id));
      while (unvisited.size) {
        let currentId = null;
        let currentDistance = Infinity;
        for (const id of unvisited) {
          const distance = distances.has(id) ? distances.get(id) : Infinity;
          if (distance < currentDistance) { currentId = id; currentDistance = distance; }
        }
        if (currentId === null) break;
        if (currentId === goalId) break;
        unvisited.delete(currentId);
        for (const nextId of neighbours.get(currentId) || []) {
          if (!unvisited.has(nextId)) continue;
          const candidate = currentDistance + cost(byId.get(currentId), byId.get(nextId));
          if (candidate < (distances.has(nextId) ? distances.get(nextId) : Infinity)) {
            distances.set(nextId, candidate);
            previous.set(nextId, currentId);
          }
        }
      }
      if (!distances.has(goalId)) return null;
      const path = [goalId];
      let cursor = goalId;
      while (previous.has(cursor)) { cursor = previous.get(cursor); path.unshift(cursor); }
      return path;
    }

    // The waypoints between two points on one floor, target excluded — the caller appends the target
    // itself, because only it knows whether the last step is a room, a landing or a body.
    function walkRoute(from, to, floor = from.floor, { y = null } = {}) {
      const start = nearestNode(from, floor, { y });
      const goal = nearestNode(to, floor, { y });
      if (!start || !goal) return [];
      const path = shortestPath(start.id, goal.id);
      if (!path) return [];
      const points = path.map((id) => byId.get(id));
      // Every route joins the graph at its nearest node, including the first leg.
      //
      // This used to drop that node whenever the body already stood closer to the goal than the node
      // did � a corridor optimisation, and a safe one in a corridor, where "closer to the goal" and
      // "further along the hall" are the same sentence. They are not the same sentence in a mall: a
      // demon standing in a storefront is a metre nearer the shop across the concourse than the aisle
      // node outside its own door is, so the node that would have walked it out of the shop was
      // discarded and the leg became a straight line through the shopfront glass. Walking a couple of
      // metres back to a waypoint looks like a demon changing its mind; walking into a wall for the
      // rest of the round does not.
      return points.map((node) => ({ x: node.x, z: node.z, floor: node.floor }));
    }

    // Which stairs to take. A building may have several — a mall has an escalator pair and a service
    // stair — so the nearest one that actually serves both floors wins.
    function connectorBetween(fromFloor, toFloor, from) {
      let best = null;
      let bestDistance = Infinity;
      for (const connector of connectors) {
        const floors = connector.floors || [];
        if (!floors.includes(fromFloor) || !floors.includes(toFloor)) continue;
        const approach = connector.approach || { x: 0, z: 0 };
        const distance = from ? Math.hypot(approach.x - from.x, approach.z - from.z) : 0;
        if (distance < bestDistance) { best = connector; bestDistance = distance; }
      }
      return best;
    }

    // The connector whose shell a point is standing inside, if any. This is what makes "the target is
    // in the stairwell" a question a mall can answer too.
    function connectorContaining(point) {
      for (const connector of connectors) {
        const bounds = connector.shell && connector.shell.bounds;
        if (!bounds) continue;
        if (point.x >= bounds.xWest - 0.2 && point.x <= bounds.xEast + 0.2
          && point.z >= bounds.zMin - 0.2 && point.z <= bounds.zMax + 0.2) return connector;
      }
      return null;
    }

    // A whole route from a body to a target, connectors included: walk to the stairs, climb them,
    // walk to the target. Every routed body in the game goes through this — the demon, the offline
    // seeker and the offline hiders — because they all move through one building and there is no
    // version of "how do I get there" that should differ between them.
    function planFloorRoute({ from, target, fromFloor, toFloor, floorHeight = 4.6 }) {
      const floorY = (floor) => (floor - 1) * floorHeight;
      const route = [];
      let cursor = { x: from.x, z: from.z, floor: fromFloor };
      if (fromFloor !== toFloor) {
        const connector = connectorBetween(fromFloor, toFloor, from);
        if (connector) {
          const entryApproach = connector.approaches?.[fromFloor] || connector.approach;
          const exitApproach = connector.approaches?.[toFloor] || connector.approach;
          for (const step of walkRoute(cursor, entryApproach, fromFloor, { y: floorY(fromFloor) })) {
            route.push({ x: step.x, y: floorY(fromFloor), z: step.z, floor: fromFloor, guided: false });
          }
          route.push(...createStairRoute({
            fromFloor, toFloor, floorHeight, stairLayout: connector.layout, approach: connector.approach, approaches: connector.approaches,
          }));
          cursor = { x: exitApproach.x, z: exitApproach.z, floor: toFloor };
        } else {
          cursor = { x: from.x, z: from.z, floor: toFloor };
        }
      }
      for (const step of walkRoute(cursor, target, toFloor, { y: floorY(toFloor) })) {
        route.push({ x: step.x, y: floorY(toFloor), z: step.z, floor: toFloor, guided: false });
      }
      route.push({ x: target.x, y: floorY(toFloor), z: target.z, floor: toFloor, guided: false });
      return route;
    }

    return { connectorBetween, connectorContaining, nearestNode, planFloorRoute, walkRoute };
  }

  // `approach` is the hall point outside the stair door. It was `(0, 42.8)` — the hotel's corridor,
  // written into the router — so a second building's stairs could not be walked to at all.
  function createStairRoute({ fromFloor, toFloor, floorHeight, stairLayout, approach = { x: 0, z: 42.8 }, approaches = {} }) {
    if (fromFloor === toFloor) return [];
    const point = (x, y, z, floor, guided = true, stair = true) => {
      const result = { x, y, z, floor, guided };
      if (stair) result.stair = true;
      return result;
    };
    const floorY = (floor) => (floor - 1) * floorHeight;
    const entryApproach = approaches[fromFloor] || approach;
    const exitApproach = approaches[toFloor] || approach;
    const route = [point(entryApproach.x, floorY(fromFloor), entryApproach.z, fromFloor, false, false)];
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
      const lanes = stairLayout.flights.filter((flight) => flight.transition === transition);
      // A switchback has two lanes with a landing between them; a straight run — an escalator, a
      // single flight — has one, and is the same walk with the middle two points collapsed. This was
      // written assuming the hotel's switchback, so a one-flight connector crashed the router.
      const west = lanes.find((flight) => flight.lane === 'west') || lanes[0];
      const east = lanes.find((flight) => flight.lane === 'east') || west;
      if (lanes.length === 1) {
        const start = point(west.startX, west.startY, west.startZ, transition);
        const end = point(west.endX, west.endY, west.endZ, transition + 1);
        route.push(...(goingUp ? [start, end] : [end, start]));
        floor += goingUp ? 1 : -1;
        continue;
      }
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
    route.push(point(exitApproach.x, floorY(toFloor), exitApproach.z, toFloor, false, false));
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
      if (east) {
        add({ x: east.startX, y: east.startY, z: east.startZ }, transition + 1);
        add({ x: east.endX, y: east.endY, z: east.endZ }, transition + 1);
      }
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
  function createStairPursuitRoute({ enemy, target, floorHeight, stairLayout, approach, approaches = {} }) {
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
      const entry = approaches[entryFloor] || approach || { x: 0, z: entrance.z };
      route.push({ x: entry.x, y: entrance.y, z: entry.z, floor: entryFloor, guided: false });
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

  return { ENEMY_STATES, aggregateEnemyState, canDetectPlayer, chooseRoamTarget, chooseSpawn, createAwareness, createNavigator, createStairPursuitRoute, createStairRoute, planarDistance, prepareHuntDoor, prepareRoamDoor, selectDetectedTarget, updateAwareness };
});
