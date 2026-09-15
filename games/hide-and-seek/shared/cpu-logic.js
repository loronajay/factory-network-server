(function attachHotelCpu(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelCpu = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelCpuApi() {
  'use strict';

  // A CPU guest in an online lobby, as a bot at the keyboard.
  //
  // The authoritative round (`sim-logic.js`) only understands inputs: a direction, a facing and four
  // held keys. That is deliberately all a CPU seat is allowed to say too. A bot here never moves a
  // body, opens a door or spends a battery — it decides what a guest *would press* and the tick
  // resolves it under exactly the rules a human is under: the same mover, the same stamina meter, the
  // same reach test on a door handle, the same catch. That is what makes a CPU seat honest online: the
  // server cannot give a bot a faster body or a wall-hack because it has no channel to do so.
  //
  // What to do — which room, when to bolt, when it counts as hidden — is `hider-logic.js`, the same
  // brain the solo stand-ins use. What this file adds is the *hands*: turning a route from the map's
  // navigation graph into a facing and a forward key, noticing when the body has stopped moving, and
  // pressing E on the door that is in the way. Nothing in here may read a wall or a floor height
  // itself; the navigator and the mover already answer those.

  const CPU_DEFAULTS = Object.freeze({
    // How close the body has to get to a waypoint before the next one is aimed at. The mover steps
    // about five centimetres a tick at walking pace, so this is a few strides of slack.
    arriveRadius: 0.36,
    // A guided stair waypoint carries its own altitude; a body that has climbed to within this of it
    // is on the same flight.
    arriveHeight: 1.4,
    // Seconds of pushing forward without moving before the bot assumes something is in the way.
    stallSeconds: 0.35,
    // Seconds stalled with no door to open before the route is abandoned and replanned.
    giveUpSeconds: 1.6,
    // How many times the same target is replanned after a blocked leg before it is struck off.
    maxRouteAttempts: 3,
    // After pressing a door handle the leaf has to swing; pushing into it before then only stalls.
    doorWaitSeconds: 0.45,
    // A door counts as "in the way" within this of the body, along the line to the next waypoint.
    doorReach: 2.6,
    doorPathWidth: 1.3,
    doorHeight: 1.5,
    bodyRadius: 0.34,
    // Standing in the room is hiding; standing outside its door is not.
    spotRadius: 2.2,
    // A frightened guest re-picks where to run at most this often. The brain asks for a fresh spot
    // on every tick a threat stays in range, and answering every one of them is a route plan per
    // tick per bot — and a guest that dithers between two doorways.
    fleeReplanSeconds: 0.6,
  });

  const NO_INPUT = Object.freeze({ forward: 0, strafe: 0, yaw: 0, crouch: false, sprint: false, light: false, interact: false, interactId: null });

  function settings(config) {
    return config ? { ...CPU_DEFAULTS, ...config } : CPU_DEFAULTS;
  }

  // The seats a lobby fills with bots. Humans always take priority: a CPU only ever sits in a chair
  // nobody has claimed, and asking for more than the room has left is not an error, just a smaller
  // answer.
  function cpuSeatIds(requested, humanCount, maxPlayers) {
    const wanted = Math.max(0, Math.floor(Number(requested) || 0));
    const free = Math.max(0, Math.floor(Number(maxPlayers) || 0) - Math.max(0, Math.floor(Number(humanCount) || 0)));
    const count = Math.min(wanted, free);
    return Array.from({ length: count }, (_, index) => `cpu-${index + 1}`);
  }

  function cpuName(id) {
    const match = /^cpu-(\d+)$/.exec(String(id || ''));
    return match ? `CPU Guest ${match[1]}` : 'CPU Guest';
  }

  function isCpuId(id) {
    return /^cpu-\d+$/.test(String(id || ''));
  }

  function createHiderBrain(id) {
    return {
      id,
      ai: null,
      route: [],
      target: null,
      unreachable: [],
      routeAttempts: 0,
      stalled: 0,
      doorWait: 0,
      yaw: 0,
      pushing: false,
      pressed: false,
      replanIn: 0,
    };
  }

  // What the driver needs from the building, built once per match. The navigator is the same one the
  // demons and the solo stand-ins route through; there is one graph and one way to walk it.
  function createDriverContext({ hotel, space, catalog = [], enemy, hiderLogic, demonLogic, roundLogic, config, hiderConfig, random = Math.random } = {}) {
    const navigator = hotel && hotel.navigation && enemy ? enemy.createNavigator(hotel.navigation, { space }) : null;
    const doors = catalog.filter((item) => item.kind === 'door');
    const doorByRoom = new Map(doors.map((item) => [item.roomNumber, item]));
    const rooms = (hotel ? hotel.roomCenters : []).map((room) => ({ id: room.roomNumber, roomNumber: room.roomNumber, floor: room.floor, x: room.x, z: room.z }));
    return {
      navigator, doors, doorByRoom, rooms, hiderLogic, demonLogic, roundLogic, random,
      config: settings(config),
      hiderConfig: hiderConfig || (hiderLogic ? hiderLogic.HIDER_DEFAULTS : {}),
      floorHeight: (config && config.floorHeight) || 4.6,
    };
  }

  function bodyOf(state, id) {
    return state.bodies.find((entry) => entry.id === id) || null;
  }

  function participantOf(state, id) {
    return (state.round && state.round.participants || []).find((entry) => entry.id === id) || null;
  }

  function isAlive(state, id) {
    const entry = participantOf(state, id);
    return !!entry && entry.alive;
  }

  function doorOf(state, ctx, item) {
    return state.fixtures && state.fixtures.doors ? state.fixtures.doors[item.id] : null;
  }

  // The rooms a guest may take: an unlocked door, and not one this guest has already failed to walk
  // into. Locked rooms need a key a bot has no plan for finding.
  function roomSpots(state, ctx, brain) {
    return ctx.rooms.filter((room) => {
      if (brain.unreachable.includes(room.id)) return false;
      const item = ctx.doorByRoom.get(room.roomNumber);
      if (!item) return true;
      const door = doorOf(state, ctx, item);
      return door ? !door.locked : !item.locked;
    });
  }

  // What a hider is afraid of, read straight off the state: the seeker, once released, and every
  // demon. The bot cannot tell a CPU seeker from a human one, and it never learns a demon's intent —
  // it sees a body in a corridor, which is all a human hider sees too.
  function threatsFor(state, ctx) {
    const threats = [];
    const seeker = ctx.roundLogic ? ctx.roundLogic.seekerOf(state.round) : (state.round.participants || []).find((entry) => entry.role === 'seeker');
    const seekerBody = seeker && seeker.alive ? bodyOf(state, seeker.id) : null;
    if (seekerBody && state.round.phase !== 'hiding') threats.push({ x: seekerBody.x, z: seekerBody.z, floor: seekerBody.floor, kind: ctx.hiderLogic.THREATS.SEEKER });
    for (const demon of state.demons || []) threats.push({ x: demon.x, z: demon.z, floor: demon.floor, kind: ctx.hiderLogic.THREATS.DEMON });
    return threats;
  }

  function reachedSpot(brain, body, cfg) {
    const spot = brain.ai && brain.ai.spot;
    if (!spot) return false;
    return body.floor === spot.floor && Math.hypot(body.x - spot.x, body.z - spot.z) < cfg.spotRadius;
  }

  function planRoute(brain, body, target, ctx) {
    if (!ctx.navigator) return { ...brain, route: [{ x: target.x, y: body.y, z: target.z, floor: target.floor }], target };
    const route = ctx.navigator.planFloorRoute({
      from: { x: body.x, y: body.y, z: body.z }, target, fromFloor: body.floor, toFloor: target.floor || body.floor, floorHeight: ctx.floorHeight,
    });
    return { ...brain, route, target, stalled: 0 };
  }

  function claimSpot(brain, body, state, ctx, threats, taken) {
    const spot = ctx.hiderLogic.chooseHideSpot(roomSpots(state, ctx, brain), { threats, taken, random: ctx.random, config: ctx.hiderConfig });
    if (!spot) return { ...brain, ai: { ...brain.ai, spot: null, needsSpot: false } };
    const claimed = { ...brain, ai: { ...brain.ai, spot, needsSpot: false }, routeAttempts: 0 };
    return planRoute(claimed, body, spot, ctx);
  }

  // Which closed door lies between the body and where it is going. Reuses the demon's own test rather
  // than a second idea of "in the way"; the bot then has to *reach* it exactly as a player would —
  // `fixtures.selectInteractable` re-tests distance, height and facing on the authority side.
  function blockingDoor(state, ctx, body, waypoint) {
    if (!ctx.demonLogic || !waypoint) return null;
    const closed = ctx.doors.filter((item) => {
      const door = doorOf(state, ctx, item);
      return door && !door.open && !door.locked;
    });
    if (!closed.length) return null;
    const cfg = ctx.config;
    return ctx.demonLogic.selectBlockingDoor(body, waypoint, closed, {
      doorReach: cfg.doorReach, doorPathWidth: cfg.doorPathWidth, catchHeight: cfg.doorHeight, bodyRadius: cfg.bodyRadius,
    });
  }

  // The camera's forward is -Z rotated by yaw, so facing a direction is the inverse of that.
  function yawToward(from, to) {
    return Math.atan2(-(to.x - from.x), -(to.z - from.z));
  }

  function driveHider(brain, state, ctx, delta, taken) {
    const cfg = ctx.config;
    const body = bodyOf(state, brain.id);
    if (!body || !isAlive(state, brain.id)) return { brain: { ...brain, route: [], pushing: false }, input: NO_INPUT };

    let next = { ...brain, ai: brain.ai || ctx.hiderLogic.createHiderState() };
    const threats = threatsFor(state, ctx);
    const arrived = !next.route.length && reachedSpot(next, body, cfg);
    // Out of waypoints but not in the room: that room cannot be walked into from here. Strike it off
    // this guest's list rather than picking it again next tick.
    if (!next.route.length && next.ai.spot && !arrived) {
      next = { ...next, unreachable: [...next.unreachable, next.ai.spot.id], ai: { ...next.ai, spot: null, needsSpot: true } };
    }
    const before = next.ai;
    next.ai = ctx.hiderLogic.updateHider(next.ai, { delta, self: body, threats, arrived, config: ctx.hiderConfig });
    next.replanIn = Math.max(0, next.replanIn - delta);
    if (next.ai.needsSpot) {
      const FLEEING = ctx.hiderLogic.HIDER_STATES.FLEEING;
      const stillRunning = next.ai.state === FLEEING && before.state === FLEEING && next.target && next.replanIn > 0;
      if (stillRunning) next.ai = { ...next.ai, spot: next.target, needsSpot: false };
      else next = { ...claimSpot(next, body, state, ctx, threats, taken), replanIn: cfg.fleeReplanSeconds };
    }

    const speed = ctx.hiderLogic.movementSpeed(next.ai, ctx.hiderConfig);
    const light = ctx.hiderLogic.flashlightOn ? ctx.hiderLogic.flashlightOn(next.ai) : false;
    const idle = { ...NO_INPUT, yaw: next.yaw, crouch: !!next.ai.crouching, light };

    // The press is one tick long. The authority reads a rising edge, so the key has to come back up
    // before it can be pressed again — and a bot holding E would strobe the door.
    if (next.pressed) return { brain: { ...next, pressed: false, pushing: false }, input: idle };
    if (next.doorWait > 0) return { brain: { ...next, doorWait: next.doorWait - delta, pushing: false }, input: idle };

    let waypoint = next.route[0];
    // Consume every waypoint the body is already standing on before deciding where to face.
    while (waypoint && Math.hypot(waypoint.x - body.x, waypoint.z - body.z) < cfg.arriveRadius && Math.abs((waypoint.y ?? body.y) - body.y) < cfg.arriveHeight) {
      next = { ...next, route: next.route.slice(1), stalled: 0 };
      waypoint = next.route[0];
    }
    if (!waypoint || !(speed > 0)) return { brain: { ...next, pushing: false, stalled: 0 }, input: idle };

    // A door in the way is opened the way a player opens it: face it, press E once, wait for the leaf.
    const door = blockingDoor(state, ctx, body, waypoint);
    if (door) {
      const yaw = yawToward(body, door);
      return {
        brain: { ...next, yaw, pressed: true, doorWait: cfg.doorWaitSeconds, stalled: 0, pushing: false },
        input: { ...NO_INPUT, yaw, light, interact: true, interactId: door.id },
      };
    }

    // The body did not move last tick although it was told to: something solid is in the way.
    const stalled = next.pushing && !body.moving ? next.stalled + delta : 0;
    if (stalled >= cfg.giveUpSeconds) {
      const target = next.target;
      if (target && next.routeAttempts < cfg.maxRouteAttempts) {
        return { brain: planRoute({ ...next, routeAttempts: next.routeAttempts + 1, pushing: false }, body, target, ctx), input: idle };
      }
      // Replanned and still stuck: give the room up. The next tick sees an empty route and moves on.
      return { brain: { ...next, route: [], stalled: 0, pushing: false }, input: idle };
    }

    const yaw = yawToward(body, waypoint);
    const fleeing = next.ai.state === ctx.hiderLogic.HIDER_STATES.FLEEING;
    return {
      brain: { ...next, yaw, stalled, pushing: true },
      input: { ...NO_INPUT, forward: 1, yaw, sprint: fleeing, light },
    };
  }

  // One tick of every CPU hider: the brains as they are now, and the input each one is pressing.
  // `taken` is every other bot's spot, so a sweep of one room is not a jackpot — the same spread the
  // solo stand-ins keep.
  function driveHiders(brains, state, ctx, delta) {
    const nextBrains = [];
    const inputs = {};
    for (let index = 0; index < brains.length; index += 1) {
      const brain = brains[index];
      const taken = [...nextBrains, ...brains.slice(index + 1)]
        .map((other) => other.ai && other.ai.spot).filter(Boolean);
      const driven = driveHider(brain, state, ctx, delta, taken);
      nextBrains.push(driven.brain);
      inputs[brain.id] = driven.input;
    }
    return { brains: nextBrains, inputs };
  }

  return { CPU_DEFAULTS, NO_INPUT, cpuName, cpuSeatIds, createDriverContext, createHiderBrain, driveHiders, isCpuId, yawToward };
});
