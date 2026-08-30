(function attachHotelDemon(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelDemon = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelDemonApi() {
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
    // A demon is 2.25m of body on a 0.32m footprint. Both numbers belong to the body, not the mover.
    bodyHeight: 2.25,
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

  function isInStairwell(point, stairShell) {
    const { xWest, xEast, zMin, zMax } = stairShell.bounds;
    return point.x >= xWest - 0.2 && point.x <= xEast + 0.2 && point.z >= zMin - 0.2 && point.z <= zMax + 0.2;
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

  // Two shapes of route: into and along the stairwell (guided, because the walk surfaces cannot
  // describe a flight), then out along the corridor spine to the target. The corridor dogleg keeps
  // the demon out of the walls when its target is inside a room off the hall.
  function planRoute(demon, target, purpose, ctx) {
    const cfg = ctx.config;
    const fromFloor = nearestFloor(demon.y, cfg);
    const toFloor = target.floor || nearestFloor(target.y, cfg);
    let route = target.inStairwell
      ? ctx.enemy.createStairPursuitRoute({
        enemy: { x: demon.x, y: demon.y, z: demon.z, floor: fromFloor, inStairwell: isInStairwell(demon, ctx.stairShell) },
        target,
        floorHeight: cfg.floorHeight,
        stairLayout: ctx.stairLayout,
      })
      : fromFloor === toFloor ? [] : ctx.enemy.createStairRoute({ fromFloor, toFloor, floorHeight: cfg.floorHeight, stairLayout: ctx.stairLayout });
    if (!target.inStairwell) {
      route = route.slice();
      if (Math.abs(target.x) > 4.25) {
        route.push(floorPoint(toFloor, 0, target.z, cfg), floorPoint(toFloor, Math.sign(target.x) * 3.75, target.z, cfg));
      }
      route.push({ x: target.x, y: floorYOf(toFloor, cfg), z: target.z, floor: toFloor, guided: false });
    }
    return { ...demon, route, routePurpose: purpose };
  }

  function choosePatrol(demon, ctx) {
    const cfg = ctx.config;
    const random = ctx.random || Math.random;
    const hallTargets = [];
    for (let floor = 1; floor <= cfg.floorCount; floor += 1) {
      for (const z of PATROL_Z) hallTargets.push(floorPoint(floor, z < -42 || z > 42 ? (random() - 0.5) * 8 : 0, z, cfg));
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
    const seen = visible ? { ...visible, inStairwell: isInStairwell(visible, ctx.stairShell) } : null;
    const remembered = !visible && next.awareness.targetId
      ? candidates.find((candidate) => candidate.id === next.awareness.targetId)
      : null;
    const clue = remembered ? { ...remembered, inStairwell: isInStairwell(remembered, ctx.stairShell) } : null;
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
    ctx.openDoorAhead(demon, target, { unlock });
    const body = { height: cfg.bodyHeight, radius: cfg.bodyRadius };
    const step = ctx.movement.stepToward(ctx.space, body, { x: demon.x, y: demon.y, z: demon.z }, target, {
      speed: speedFor(demon, ctx), delta, arriveRadius: cfg.arriveRadius, guided: !!target.guided, avoidance: demon.avoidance,
    });
    if (step.arrived) {
      return { ...demon, x: round6(step.x), y: round6(step.y), z: round6(step.z), route: demon.route.slice(1), moving: false, avoidance: null };
    }
    if (!step.moved) return { ...demon, moving: false, avoidance: step.avoidance || null };
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

  // Where a demon starts. Away from the seeker, and away from whichever floor the other demon took —
  // a round must not open with both of them in one stairwell.
  function chooseDemonSpawn({ enemy, player, random = Math.random, excludedFloors = [], config } = {}) {
    const cfg = settings(config);
    const spawns = [];
    for (let floor = 1; floor <= cfg.floorCount; floor += 1) {
      for (const z of [-52, -28, 0, 28, 49]) {
        spawns.push(floorPoint(floor, z < -42 || z > 42 ? 0 : (random() - 0.5) * 3, z, cfg));
      }
    }
    return enemy.chooseSpawn(spawns, player, random, 24, excludedFloors);
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
    caughtBy, chooseDemonSpawn, choosePatrol, createDemon, describeDemon, isInStairwell,
    nearestFloor, planRoute, selectBlockingDoor, tickDemon,
  };
});
