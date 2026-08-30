(function attachHotelDemon(root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./collision-logic.js') : root.HotelCollision);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelDemon = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelDemonApi(collision) {
  'use strict';

  // A demon as a body and a mind, with no renderer anywhere near it.
  //
  // `enemy-logic.js` already held the *rules* — what can be seen, how a stair route is built, how
  // awareness decays. What was still trapped in `modules/monster.js` was the thing that used them:
  // where this demon is standing, which waypoint it is walking to, and when it decides to replan.
  // That is what this file is, and it is why online rounds used to open with an empty hotel.
  //
  // A demon hunts everyone. It is not the seeker's ally and it does not know what a role is — the
  // three-way tension the whole game is built on only works if the thing in the corridor is
  // genuinely indifferent to who you are.

  const DEFAULTS = Object.freeze({
    // A demon is 2.25m of body on a 0.32m footprint, and it stoops. `bodyHeight` is what the mover
    // needs clearance for, and every door in the game is 2.12m tall: a hunter measured at its full
    // standing height cannot pass under a doorway header, so on a map that models one it simply
    // stops in front of the service corridor and shuffles there for the rest of the round. The
    // building decides how tall a thing may walk through it; the demon ducks.
    bodyHeight: 2.05,
    bodyRadius: 0.32,
    eyeHeight: 2.05,
    // Detection is expensive (a sight ray per candidate), so it runs on its own slower clock. The
    // demon still *moves* every tick; it just does not re-look every tick.
    detectionInterval: 0.085,
    // Once a chase starts, the demon keeps track of a nearby target it can still see even while its
    // body turns through a doorway or around a corner. The normal forward cone still gates the
    // initial sighting; this is short-range chase awareness, not eyes in the back of its head.
    chaseAwarenessDistance: 10,
    replanInterval: 0.65,
    arriveRadius: 0.18,
    turnRate: 7,
    floorHeight: 4.6,
    floorCount: 4,
    catchDistance: 1.05,
    catchHeight: 1.15,
    walkSpeed: 2.25,
    chaseSpeed: 4.85,
    huntSpeed: 3.05,
    roomChance: 0.24,
    doorOpenAngle: Math.PI / 2,
    doorReach: 1.65,
    doorPathWidth: 1.15,
    sightTolerance: 0.18,
  });

  const PATROL_Z = Object.freeze([-52, -34, -18, 0, 18, 34, 49]);

  function settings(config) {
    return config ? { ...DEFAULTS, ...config } : DEFAULTS;
  }

  const round6 = (value) => Math.round(Number(value) * 1e6) / 1e6;

  function nearestFloor(y, cfg) {
    return Math.max(1, Math.min(cfg.floorCount, Math.round(y / cfg.floorHeight) + 1));
  }

  function floorYOf(floor, cfg) {
    return (floor - 1) * cfg.floorHeight;
  }

  // The cabin is protected even with its doors open. The hall outside remains huntable.
  function isSafeHaven(point, elevator) {
    return collision.inCabinFootprint(point, elevator, { frontMargin: 0 });
  }

  // "Is this body on the stairs" — asked of the building rather than of one hotel's shell, because a
  // mall's escalators and service stair are two separate volumes and neither is the hotel's.
  //
  // A raw shell is still accepted so a caller holding one keeps working; a context resolves through
  // its navigation instead.
  function isInStairwell(point, source) {
    if (source?.enemy && (source.navigation || source.hotel?.navigation)) return !!navigatorOf(source).connectorContaining(point);
    const shells = shellsOf(source);
    for (const bounds of shells) {
      if (point.x >= bounds.xWest - 0.2 && point.x <= bounds.xEast + 0.2
        && point.z >= bounds.zMin - 0.2 && point.z <= bounds.zMax + 0.2) return true;
    }
    return false;
  }

  function shellsOf(source) {
    if (!source) return [];
    if (source.bounds) return [source.bounds];
    const navigation = source.navigation || (source.stairShell ? null : source);
    const connectors = (navigation && navigation.connectors) || [];
    const bounds = connectors.map((connector) => connector.shell && connector.shell.bounds).filter(Boolean);
    if (bounds.length) return bounds;
    return source.stairShell && source.stairShell.bounds ? [source.stairShell.bounds] : [];
  }

  // One navigator per context, built once and cached on it. Rebuilding the graph's lookup tables
  // sixty times a second for every demon would be the most expensive thing in the tick.
  function navigatorOf(ctx) {
    if (ctx.navigator) return ctx.navigator;
    const navigation = ctx.navigation || (ctx.hotel && ctx.hotel.navigation) || null;
    const navigator = ctx.enemy.createNavigator(navigation || { nodes: [], edges: [], connectors: [] }, { space: ctx.space });
    ctx.navigator = navigator;
    return navigator;
  }

  // `hunts` is what separates The Bellhop from The Housekeeper: only one demon reads the sanity
  // meter, deliberately, so the anti-camping rule reads as one stalker rather than a swarm.
  function createDemon({ id, name = 'The Bellhop', spawn, hunts = false } = {}) {
    return {
      id: id || name,
      name,
      hunts: !!hunts,
      x: spawn.x, y: spawn.y, z: spawn.z,
      facingX: 0, facingZ: 1,
      floor: spawn.floor || 1,
      awareness: null,
      route: [],
      routePurpose: 'roam',
      avoidance: null,
      moving: false,
      detectionCooldown: 0,
      chasePlanCooldown: 0,
      plannedChaseFloor: null,
      huntZone: null,
      huntTargetId: null,
      detectedTargetId: null,
    };
  }

  // --- routing ----------------------------------------------------------------------------------

  function floorPoint(floor, x, z, cfg, guided = false) {
    return { x, y: floorYOf(floor, cfg), z, floor, guided };
  }

  // Two shapes of route: into and along a vertical connector (guided, because the walk surfaces
  // cannot describe a flight), then across the destination floor's waypoint graph to the target.
  //
  // The floor-crossing half used to be arithmetic against this hotel: walk to the corridor spine at
  // x=0, then step out to |x|=3.75 if the target sat off it. That dogleg *is* a corridor's
  // floorplan, and it is the reason the AI could not be pointed at a second building. The map's
  // navigation graph says the same thing as data, so the hotel still reaches a room by walking the
  // hall to its Z and stepping in, and a mall reaches a store by walking the ring round its atrium.
  function planRoute(demon, target, purpose, ctx) {
    const cfg = ctx.config;
    if (isSafeHaven(target, cfg.elevator)) return { ...demon, route: [], routePurpose: purpose };
    const navigator = navigatorOf(ctx);
    const fromFloor = nearestFloor(demon.y, cfg);
    const toFloor = target.floor || nearestFloor(target.y, cfg);

    if (target.inStairwell) {
      const connector = navigator.connectorContaining(target) || navigator.connectorBetween(fromFloor, toFloor, demon);
      const route = connector ? ctx.enemy.createStairPursuitRoute({
        enemy: { x: demon.x, y: demon.y, z: demon.z, floor: fromFloor, inStairwell: isInStairwell(demon, ctx) },
        target,
        floorHeight: cfg.floorHeight,
        stairLayout: connector.layout,
        approach: connector.approach, approaches: connector.approaches,
      }) : [];
      return { ...demon, route, routePurpose: purpose };
    }

    const route = navigator.planFloorRoute({
      from: { x: demon.x, z: demon.z }, target, fromFloor, toFloor, floorHeight: cfg.floorHeight,
    });
    return { ...demon, route, routePurpose: purpose };
  }

  function choosePatrol(demon, ctx) {
    const cfg = ctx.config;
    const random = ctx.random || Math.random;
    // Where there is to walk is the building's answer. `PATROL_Z` is the hotel's corridor stops and
    // is only the fallback for a plan that publishes no navigation — pointing a mall demon at a
    // hotel's Z values sends it patrolling coordinates that are not in its building.
    const nodes = ctx.navigation && ctx.navigation.nodes;
    const hallTargets = [];
    if (nodes && nodes.length) {
      for (const node of nodes) hallTargets.push(floorPoint(node.floor, node.x, node.z, cfg));
    } else {
      for (let floor = 1; floor <= cfg.floorCount; floor += 1) {
        for (const z of PATROL_Z) hallTargets.push(floorPoint(floor, z < -42 || z > 42 ? (random() - 0.5) * 8 : 0, z, cfg));
      }
    }
    const roomTargets = ctx.rooms
      .filter((room) => !ctx.isRoomLocked(room.roomNumber))
      .map((room) => ({ id: room.roomNumber, floor: room.floor, x: room.x, z: room.z, y: floorYOf(room.floor, cfg) }));
    const target = ctx.enemy.chooseRoamTarget({ hallTargets, roomTargets, roomChance: cfg.roomChance }, random);
    if (!target) return demon;
    // Roaming, the demon lets itself into whatever was already unlocked. It does not force a lock —
    // that privilege belongs to the hunt.
    if (target.room) ctx.openDoor(target.id, { unlock: false });
    return planRoute(demon, target, 'roam', ctx);
  }

  // --- awareness --------------------------------------------------------------------------------

  function sightBlockedTo(demon, target, ctx) {
    const cfg = ctx.config;
    return ctx.space.sightBlocked(
      { x: demon.x, y: demon.y + cfg.eyeHeight, z: demon.z },
      { x: target.x, y: target.y + (target.crouching ? 0.9 : 1.55), z: target.z },
      { tolerance: cfg.sightTolerance },
    );
  }

  function updateAwareness(demon, delta, ctx) {
    const cfg = ctx.config;
    let next = { ...demon, detectionCooldown: demon.detectionCooldown - delta, chasePlanCooldown: demon.chasePlanCooldown - delta };
    if (next.detectionCooldown > 0) return next;
    next.detectionCooldown = cfg.detectionInterval;
    const candidates = ctx.candidates;
    const eye = { x: next.x, y: next.y, z: next.z, facingX: next.facingX, facingZ: next.facingZ };
    let visible = ctx.enemy.selectDetectedTarget(candidates, eye, { isOccluded: (target) => sightBlockedTo(next, target, ctx) });
    if (!visible && next.awareness.state === ctx.enemy.ENEMY_STATES.CHASE && next.awareness.targetId) {
      const tracked = candidates.find((candidate) => candidate.id === next.awareness.targetId);
      if (tracked && ctx.enemy.canDetectPlayer({
        enemy: eye,
        player: tracked,
        occluded: sightBlockedTo(next, tracked, ctx),
        maxDistance: cfg.chaseAwarenessDistance,
        fieldOfView: Math.PI * 2,
      })) visible = tracked;
    }
    next.detectedTargetId = visible ? visible.id : null;
    const seen = visible ? { ...visible, inStairwell: isInStairwell(visible, ctx) } : null;
    const remembered = !visible && next.awareness.targetId
      ? candidates.find((candidate) => candidate.id === next.awareness.targetId)
      : null;
    const clue = remembered ? { ...remembered, inStairwell: isInStairwell(remembered, ctx) } : null;
    const previousState = next.awareness.state;
    next.awareness = ctx.enemy.updateAwareness(next.awareness, {
      seesPlayer: !!visible,
      delta: cfg.detectionInterval,
      playerId: visible ? visible.id : null,
      playerPosition: seen,
      pursuitClue: clue,
    });
    const { ENEMY_STATES } = ctx.enemy;
    if (next.awareness.state === ENEMY_STATES.CHASE) {
      const targetFloor = next.awareness.lastSeen.floor;
      // A route that has entered the stairwell is committed: replanning halfway up a flight walks
      // the demon back out through the shaft wall.
      const committedToStairs = next.route.some((point) => point.stair);
      if (previousState !== ENEMY_STATES.CHASE || !next.route.length || (!committedToStairs && next.chasePlanCooldown <= 0)) {
        next = planRoute(next, next.awareness.lastSeen, 'chase', ctx);
        next.plannedChaseFloor = targetFloor;
        next.chasePlanCooldown = cfg.replanInterval;
      } else if (next.plannedChaseFloor !== targetFloor && !committedToStairs) {
        next = planRoute(next, next.awareness.lastSeen, 'chase', ctx);
        next.plannedChaseFloor = targetFloor;
      }
    } else if (next.awareness.state === ENEMY_STATES.SEARCH && next.awareness.lastSeen
      && (previousState === ENEMY_STATES.CHASE || (next.awareness.clueActive && next.chasePlanCooldown <= 0) || !next.route.length)) {
      next = planRoute(next, next.awareness.lastSeen, 'search', ctx);
      next.chasePlanCooldown = cfg.replanInterval;
    }
    if (next.awareness.state !== previousState) ctx.emit({ type: 'demon-state', demon: next.name, state: next.awareness.state, targetId: next.detectedTargetId });
    return next;
  }

  // The sanity hunt. A player who has been still long enough stops being hidden: the demon walks to
  // the room they are camping in and prowls it until they move (which resets their meter and calls it
  // off) or it sees them (which is a chase, and chase always wins). It only fires from ROAM — an
  // active search is a fresher lead, and stacking the two would double-plan the route.
  function updateHunt(demon, ctx) {
    const { ENEMY_STATES } = ctx.enemy;
    if (!demon.hunts || demon.awareness.state !== ENEMY_STATES.ROAM) {
      if (demon.huntZone && demon.awareness.state !== ENEMY_STATES.ROAM) {
        ctx.setHunted(null);
        return { ...demon, huntZone: null, huntTargetId: null };
      }
      return demon;
    }
    const cfg = ctx.config;
    const target = ctx.sanity.selectHuntTarget(
      ctx.huntCandidates,
      { x: demon.x, z: demon.z, floor: nearestFloor(demon.y, cfg) },
      ctx.sanityConfig,
    );
    if (!target) {
      if (!demon.huntZone) return demon;
      ctx.setHunted(null);
      return { ...demon, huntZone: null, huntTargetId: null, route: [], routePurpose: 'roam' };
    }
    const random = ctx.random || Math.random;
    if (demon.huntZone !== target.zone || demon.huntTargetId !== target.id) {
      // Hunting, the demon does force a lock. A locked room is a hiding place, not a fortress.
      ctx.openDoor(target.zone, { unlock: true });
      const planned = planRoute(demon, { x: target.x, y: floorYOf(target.floor, cfg), z: target.z, floor: target.floor }, 'hunt', ctx);
      ctx.setHunted(target);
      ctx.emit({ type: 'sanity-hunt', demon: demon.name, id: target.id, zone: target.zone, floor: target.floor });
      return { ...planned, huntZone: target.zone, huntTargetId: target.id };
    }
    if (!demon.route.length) {
      // Reached the room and still cannot see them: prowl it rather than stand in the doorway.
      const angle = random() * Math.PI * 2;
      const radius = 1.2 + random() * 2.2;
      return planRoute(demon, {
        x: target.x + Math.cos(angle) * radius,
        y: floorYOf(target.floor, cfg),
        z: target.z + Math.sin(angle) * radius,
        floor: target.floor,
      }, 'hunt', ctx);
    }
    return { ...demon, routePurpose: 'hunt' };
  }

  // --- walking ----------------------------------------------------------------------------------

  function speedFor(demon, ctx) {
    const cfg = ctx.config;
    const { ENEMY_STATES } = ctx.enemy;
    if (demon.awareness.state === ENEMY_STATES.CHASE) return cfg.chaseSpeed;
    if (demon.awareness.state === ENEMY_STATES.SEARCH) return cfg.walkSpeed * 1.22;
    return demon.routePurpose === 'hunt' ? cfg.huntSpeed : cfg.walkSpeed;
  }

  // Select only a doorway that is immediately ahead on the current leg. A broad "nearest door"
  // check can open a room behind the demon (or the matching doorway one floor above), while still
  // leaving the collider in front of its face untouched.
  function selectBlockingDoor(demon, target, doors, config) {
    const cfg = settings(config);
    const routeX = target.x - demon.x;
    const routeZ = target.z - demon.z;
    const routeLength = Math.hypot(routeX, routeZ);
    if (!(routeLength > 0.01)) return null;
    let selected = null;
    let bestScore = Infinity;
    for (const door of doors || []) {
      if (!door) continue;
      if (door.floor && demon.floor && door.floor !== demon.floor) continue;
      if (Number.isFinite(door.y) && Math.abs(door.y - demon.y) > cfg.catchHeight) continue;
      const dx = door.x - demon.x;
      const dz = door.z - demon.z;
      const distance = Math.hypot(dx, dz);
      if (distance > cfg.doorReach) continue;
      const progress = (dx * routeX + dz * routeZ) / routeLength;
      if (progress < -0.05 || progress > routeLength + cfg.bodyRadius) continue;
      const pathDistance = Math.abs(dx * routeZ - dz * routeX) / routeLength;
      if (pathDistance > cfg.doorPathWidth) continue;
      const score = distance + pathDistance * 0.5;
      if (score < bestScore) { selected = door; bestScore = score; }
    }
    return selected;
  }

  function walk(demon, delta, ctx) {
    const cfg = ctx.config;
    const target = demon.route[0];
    if (!target) return { ...demon, moving: false };
    const { ENEMY_STATES } = ctx.enemy;
    const unlock = demon.routePurpose === 'hunt'
      || demon.awareness.state === ENEMY_STATES.CHASE
      || demon.awareness.state === ENEMY_STATES.SEARCH;
    // An opening leaf is temporarily solid. Keep the crossing waypoint and let the swing finish
    // instead of sliding into its hinge or discarding the doorway from the route.
    if (ctx.openDoorAhead(demon, target, { unlock })) return { ...demon, moving: false, avoidance: null };
    const body = { height: cfg.bodyHeight, radius: cfg.bodyRadius };
    const step = ctx.movement.stepToward(ctx.space, body, { x: demon.x, y: demon.y, z: demon.z }, target, {
      speed: speedFor(demon, ctx), delta, arriveRadius: cfg.arriveRadius, guided: !!target.guided, avoidance: demon.avoidance,
    });
    if (isSafeHaven(step, cfg.elevator)) return { ...demon, moving: false, route: [], avoidance: null };
    if (step.arrived) {
      return { ...demon, x: round6(step.x), y: round6(step.y), z: round6(step.z), route: demon.route.slice(1), moving: false, avoidance: null };
    }
    // Wedged. The offline hiders and the CPU seeker both give a waypoint up when the mover reports
    // the way solid, and a demon has to do the same: without it a leg that cannot be walked is
    // retried at sixty hertz forever, and a hunter standing in a doorway for the rest of the round
    // is worse than one that takes a wrong turn.
    if (!step.moved) {
      return {
        ...demon,
        moving: false,
        avoidance: step.avoidance || null,
        route: step.blocked ? demon.route.slice(1) : demon.route,
      };
    }
    const turn = Math.min(1, delta * cfg.turnRate);
    let facingX = demon.facingX;
    let facingZ = demon.facingZ;
    if (Math.hypot(step.dirX, step.dirZ) > 0.01) {
      facingX += (step.dirX - facingX) * turn;
      facingZ += (step.dirZ - facingZ) * turn;
      const length = Math.hypot(facingX, facingZ) || 1;
      facingX /= length;
      facingZ /= length;
    }
    return {
      ...demon,
      x: round6(step.x), y: round6(step.y), z: round6(step.z),
      facingX: round6(facingX), facingZ: round6(facingZ),
      moving: Math.hypot(step.dirX, step.dirZ) > 0.01,
      avoidance: step.avoidance || null,
    };
  }

  // Who this demon is standing on top of. Position-resolved on the authority, exactly like a tag,
  // and — exactly like a tag — a wall between the two of them counts.
  //
  // Distance alone is not enough: the head start shuts the seeker inside the elevator cabin, and a
  // demon that arrived in the lobby was reaching straight through the closed doors and ending the
  // round fourteen seconds in. Anything solid enough to stop a body is solid enough to stop a hand,
  // so the closed cabin, a shut door and a wall are all real cover against a demon now.
  //
  // The sight test only runs for a candidate already within arm's reach, so this costs a ray on the
  // rare tick where somebody is about to die rather than one per body per tick.
  function caughtBy(demon, candidates, config, space = null) {
    const cfg = settings(config);
    const caught = [];
    for (const candidate of candidates || []) {
      if (!candidate) continue;
      if (isSafeHaven(candidate, cfg.elevator)) continue;
      if (Math.abs(candidate.y - demon.y) >= cfg.catchHeight) continue;
      if (Math.hypot(candidate.x - demon.x, candidate.z - demon.z) >= cfg.catchDistance) continue;
      if (space && space.sightBlocked && space.sightBlocked(
        { x: demon.x, y: demon.y + 1.2, z: demon.z },
        { x: candidate.x, y: candidate.y + (candidate.crouching ? 0.9 : 1.2), z: candidate.z },
        { tolerance: cfg.sightTolerance },
      )) continue;
      caught.push(candidate.id);
    }
    return caught;
  }

  // One demon, one tick. `ctx` carries the world (`space`), who is in it (`candidates`), the pure
  // rule modules, and the two callbacks that reach outside a demon: opening a door and telling a
  // player they are being hunted.
  function tickDemon(demon, delta, ctx) {
    const cfg = settings(ctx.config);
    const context = {
      ...ctx,
      config: cfg,
      candidates: (ctx.candidates || []).filter((candidate) => !isSafeHaven(candidate, cfg.elevator)),
      huntCandidates: (ctx.huntCandidates || []).filter((candidate) => !isSafeHaven(candidate, cfg.elevator)),
      emit: ctx.emit || (() => {}),
      setHunted: ctx.setHunted || (() => {}),
      openDoor: ctx.openDoor || (() => {}),
      openDoorAhead: ctx.openDoorAhead || (() => {}),
    };
    let next = demon.awareness ? demon : { ...demon, awareness: ctx.enemy.createAwareness() };
    next = updateAwareness(next, delta, context);
    next = updateHunt(next, context);
    const { ENEMY_STATES } = ctx.enemy;
    if (next.awareness.state === ENEMY_STATES.ROAM && !next.route.length) next = choosePatrol(next, context);
    if (next.awareness.state === ENEMY_STATES.SEARCH && !next.route.length && next.awareness.lastSeen) {
      const random = context.random || Math.random;
      const angle = random() * Math.PI * 2;
      const radius = 2 + random() * 3;
      next = planRoute(next, {
        ...next.awareness.lastSeen,
        x: next.awareness.lastSeen.x + Math.cos(angle) * radius,
        z: next.awareness.lastSeen.z + Math.sin(angle) * radius,
      }, 'search', context);
    }
    next = walk(next, delta, context);
    next.floor = nearestFloor(next.y, cfg);
    return next;
  }

  // Where a demon starts: away from every player, and away from the demons already placed.
  //
  // "Away" used to mean *a different floor*, which worked only because the one map was four floors
  // deep and carried two demons. Cinder Mall is two levels with three of them, so a floor each is
  // arithmetic with no answer — and a floor was never what mattered. What a round must not open with
  // is two demons in the same corridor; two at opposite ends of a 96-metre concourse is fine. So the
  // separation is a distance, and a floor change simply counts as plenty of it.
  function chooseDemonSpawn({ enemy, player, players = [], random = Math.random, excludedFloors = [], taken = [], navigation = null, config } = {}) {
    const cfg = settings(config);
    const separation = (navigation && navigation.minSpawnSeparation) || 24;
    const nodes = navigation && navigation.spawnNodes && navigation.spawnNodes.length ? navigation.spawnNodes : null;
    const spawns = nodes
      ? nodes.map((node) => floorPoint(node.floor, node.x, node.z, cfg))
      : (() => {
        const generated = [];
        for (let floor = 1; floor <= cfg.floorCount; floor += 1) {
          for (const z of [-52, -28, 0, 28, 49]) {
            generated.push(floorPoint(floor, z < -42 || z > 42 ? 0 : (random() - 0.5) * 3, z, cfg));
          }
        }
        return generated;
      })();

    // Demon spacing may fall back to the player-safe set; player clearance is never relaxed.
    const protectedPlayers = [...players, ...(player ? [player] : [])];
    const safe = spawns.filter((spawn) => protectedPlayers.every((other) => (
      spawn.floor !== other.floor || Math.hypot(spawn.x - other.x, spawn.z - other.z) >= separation
    )));
    // Player clearance is mandatory, even when demon-to-demon spacing cannot be satisfied.
    if (!safe.length) throw new Error('Map has no demon start clear of all player spawns');
    const clear = safe.filter((spawn) => taken.every((other) => (
      spawn.floor !== other.floor || Math.hypot(spawn.x - other.x, spawn.z - other.z) >= separation
    )));
    const pool = clear.length ? clear : safe;
    const allowed = pool.filter((spawn) => !excludedFloors.includes(spawn.floor));
    const available = allowed.length ? allowed : pool;
    return available[Math.min(available.length - 1, Math.floor(random() * available.length))];
  }

  // What a client is told about a demon. Its position has to be here — a body nobody can draw is not
  // a body — but nothing about its intent is: the vignette gets one aggregated state for the whole
  // roster, which is the same rule that removed the tracker minimap.
  function describeDemon(demon) {
    return {
      id: demon.id,
      name: demon.name,
      x: round6(demon.x), y: round6(demon.y), z: round6(demon.z),
      yaw: round6(Math.atan2(demon.facingX, demon.facingZ)),
      moving: !!demon.moving,
      state: demon.awareness ? demon.awareness.state : 'roam',
      routePurpose: demon.routePurpose,
    };
  }

  return {
    DEFAULTS, PATROL_Z,
    caughtBy, chooseDemonSpawn, choosePatrol, createDemon, describeDemon, isInStairwell, isSafeHaven,
    nearestFloor, planRoute, selectBlockingDoor, tickDemon,
  };
});
