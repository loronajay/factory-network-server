(function attachHotelSim(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelSim = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelSimApi() {
  'use strict';

  // The authoritative round, as one function of (state, inputs) -> state.
  //
  // Everything a round is made of already lives in the pure layer — the building in `hotel-plan.js`,
  // walking in `movement-logic.js`, the clock and both endings in `round-logic.js`, the meters in
  // `stamina-logic.js` / `sanity-logic.js` / `flashlight-logic.js`, the doors and the lift in
  // `fixtures-logic.js`, and the hunt in `demon-logic.js`. This file is the one place they are ticked
  // together, so the same simulation runs in the browser and on the server with no renderer in either.
  //
  // The rule that shapes all of it: a client sends what it is trying to do, never what happened. An
  // input carries a direction, a facing and four held keys. Whether you moved, whether your battery is
  // empty, whether the drawer you opened still had the key in it and whether you were caught are
  // answers this file gives — a client that says "I wasn't caught" or "my light is full" is ignored,
  // which is what makes this safe to run as the authority.
  //
  // Dependencies are injected rather than reached for, so the browser hands in its `window.Hotel*`
  // globals and Node hands in the same modules through `require`.

  const PLAYER_DEFAULTS = Object.freeze({
    walkSpeed: 3.1,
    sprintSpeed: 5.4,
    crouchSpeed: 1.9,
    bodyHeight: 1.78,
    playerRadius: 0.34,
    eyeHeight: 1.62,
    crouchEyeHeight: 1.02,
    floorHeight: 4.6,
    // How tall the building is. The hotel's four was assumed in three separate places before maps
    // were a registry; it is a map's number now and every one of them reads it from here.
    floorCount: 4,
    elevatorCenterX: 2.5,
    elevatorCenterZ: 57.45,
    elevatorFrontZ: 55.88,
  });

  // How close a body has to be to a dropped battery to claim it. Deliberately generous compared to a
  // tag: a resupply you can see and cannot pick up is only frustrating, while a tag you cannot dodge
  // is a broken game.
  const PICKUP_RADIUS = 1.15;
  const PICKUP_HEIGHT = 1.3;

  const NO_INPUT = Object.freeze({ forward: 0, strafe: 0, yaw: 0, crouch: false, sprint: false, light: false, interact: false });

  const clean = (value) => Math.round(Number(value) * 1e6) / 1e6;

  // Only these fields are read off an input. Anything else a client attaches — a position, a charge,
  // an "I tagged them" — never reaches the state.
  function readInput(raw) {
    if (!raw) return NO_INPUT;
    const forward = Math.max(-1, Math.min(1, Number(raw.forward) || 0));
    const strafe = Math.max(-1, Math.min(1, Number(raw.strafe) || 0));
    const yaw = Number.isFinite(raw.yaw) ? Number(raw.yaw) : 0;
    return { forward, strafe, yaw, crouch: !!raw.crouch, sprint: !!raw.sprint, light: !!raw.light, interact: !!raw.interact };
  }

  // The world the simulation walks, built straight off the plan. `modules/world.js` is the browser's
  // version of this — the same questions, answered from the same records — and this is the one a
  // server uses. Doors are the only layout that moves, so the collider set is rebuilt when one does
  // and cached in between: resolving 700-odd boxes per query per body per tick is not a tick budget.
  //
  // The elevator cabin is the exception and is kept in a separate short list. It moves continuously
  // while travelling, and folding it into the cached set would rebuild all 700 boxes every tick.
  function createPlanSpace({ plan, collision, hotel, config = {}, openings = {}, dynamicHeights = {} } = {}) {
    // Bounds, hinges, collider resolution and walk heights are shared plan geometry and live in
    // `collision-logic.js`. They used to be reached through the *hotel's* plan module, which is why
    // every call site still passes one: a second map cannot sensibly ask the first where its own
    // floor is. Both plan modules re-export them, so an older caller passing only `plan` still works.
    const geometry = (collision && collision.resolveColliders) ? collision : plan;
    const groundSnap = config.groundSnap;
    const bodyHeight = config.bodyHeight;
    const playerRadius = config.playerRadius;
    const doorState = { ...openings };
    let cached = null;
    let dynamic = [];
    let rebuilds = 0;

    function colliders() {
      if (!cached) { cached = geometry.resolveColliders(hotel, doorState); rebuilds += 1; }
      return cached;
    }
    function setOpening(id, value) {
      if (doorState[id] === value) return false;
      doorState[id] = value;
      cached = null;
      return true;
    }
    return {
      colliders,
      setOpening,
      setDynamicBoxes(boxes) { dynamic = boxes || []; },
      dynamicBoxes: () => dynamic,
      rebuilds: () => rebuilds,
      openings: () => ({ ...doorState }),
      setDynamicHeight(id, value) { dynamicHeights[id] = value; },
      groundAt: (x, z, fromY) => geometry.walkHeightAt(hotel.surfaces, x, z, fromY, groundSnap, dynamicHeights),
      blocked(x, z, feetY, height = bodyHeight, radius = playerRadius) {
        const body = { x, z, feetY, bodyHeight: height, radius };
        return collision.collidesAt(colliders(), body) || (dynamic.length > 0 && collision.collidesAt(dynamic, body));
      },
      sightBlocked(from, to, options) {
        return collision.segmentBlocked(colliders(), from, to, options)
          || (dynamic.length > 0 && collision.segmentBlocked(dynamic, from, to, options));
      },
    };
  }

  // The roster a simulation falls back on when nothing hands it one: the hotel's two, which is what
  // every caller passed implicitly before maps were a registry. A map's roster comes from
  // `map-catalog.js` and arrives as `config.demons`; this keeps a bare `createSimulation` — a unit
  // test, a prototype — from needing a catalog to stand up a round.
  const DEFAULT_DEMONS = Object.freeze([
    Object.freeze({ id: 'bellhop', name: 'The Bellhop', hunts: true }),
    Object.freeze({ id: 'housekeeper', name: 'The Housekeeper', hunts: false }),
  ]);

  // A roster is untrusted the moment it can come from a lobby setting, so it is bounded here: real
  // entries only, a name that is a name, and a ceiling on how many things may hunt at once.
  const MAX_DEMONS = 6;
  function normalizeRoster(demons) {
    const list = Array.isArray(demons) && demons.length ? demons : DEFAULT_DEMONS;
    return list
      .filter((entry) => entry && typeof entry === 'object' && entry.id)
      .slice(0, MAX_DEMONS)
      .map((entry) => ({ id: String(entry.id), name: String(entry.name || entry.id), hunts: !!entry.hunts }));
  }

  function createSimulation({
    movement, round, stamina, flashlight, sanity, fixtures, demon: demonLogic, enemy, layout,
    collision, space, plan: hotel, zones = [], config = {}, random = Math.random,
  } = {}) {
    const player = { ...PLAYER_DEFAULTS, ...(config.player || {}) };
    const roundConfig = config.round;
    const flashlightConfig = config.flashlight;
    const staminaConfig = config.stamina;
    const sanityConfig = config.sanity;
    // Where the lift is belongs to the building, not to the player's tuning. A plan that predates
    // the field falls back on the hotel's numbers so an older fixture still stands a round up.
    const shaft = (hotel && hotel.elevator) || {
      centerX: player.elevatorCenterX, centerZ: player.elevatorCenterZ, frontZ: player.elevatorFrontZ,
    };
    // Which way the cabin opens is the plan's, not the engine's: `frontZ < centerZ` was the hotel's
    // answer and got written into every Z comparison as a bare minus sign. Both tests below ask
    // `inCabinFootprint` instead, so a lift that opens toward +Z reads identically.
    const inCabin = (position) => (collision && collision.inCabinFootprint
      ? collision.inCabinFootprint(position, shaft)
      : Math.abs(position.x - shaft.centerX) < 1.12
        && (position.z - shaft.centerZ) * (shaft.frontZ > shaft.centerZ ? 1 : -1) > -1.46
        && (position.z - shaft.centerZ) * (shaft.frontZ > shaft.centerZ ? 1 : -1)
          < Math.abs(shaft.frontZ - shaft.centerZ) + 0.12);
    const fixtureConfig = { ...(config.fixtures || {}), floorHeight: player.floorHeight, elevatorCenterX: shaft.centerX, elevatorCenterZ: shaft.centerZ, elevatorFrontZ: shaft.frontZ };
    const demonConfig = { ...(config.demon || {}), floorHeight: player.floorHeight, floorCount: player.floorCount, elevator: shaft };
    // The roster is the map's, and its length is the demon count. Two was the hotel's number, never
    // a rule — a simulation given three walks, looks and catches with three.
    const demonRoster = normalizeRoster(config.demons);
    const body = { height: player.bodyHeight, radius: player.playerRadius };
    // Older adapters publish room centres only; retain authored bounds from the plan itself.
    let zoneList = zones.map(zone => ({ ...hotel?.roomCenters.find(room => room.roomNumber === zone.id), ...zone }));

    // Fixtures and demons need the plan; a simulation without one is the older player-only shape and
    // still ticks, which is what keeps `tests/sim-logic.test.js` free of a whole hotel.
    const catalog = hotel && fixtures ? fixtures.createFixtureCatalog(hotel, { config: fixtureConfig }) : [];
    const catalogById = new Map(catalog.map((item) => [item.id, item]));
    const doorCatalog = catalog.filter((item) => item.kind === 'door');
    const demonDoorCatalog = catalog.filter((item) => item.kind === 'door' || item.kind === 'panel');
    const doorByRoom = new Map(doorCatalog.map((item) => [item.roomNumber, item]));
    const rooms = hotel ? hotel.roomCenters.map((room) => ({ roomNumber: room.roomNumber, floor: room.floor, x: room.x, z: room.z })) : [];
    // How a demon gets around this building comes off the building itself. It used to be read out of
    // `layout.js`, which is one hotel's stairwell — a mall has an escalator pair and a service stair
    // and neither is that. A plan with no navigation still ticks: its demons walk straight at what
    // they want, which is the correct answer for a map that is a single open room.
    const navigation = (hotel && hotel.navigation) || null;
    const navigator = navigation && enemy ? enemy.createNavigator(navigation, { space }) : null;

    function setZones(next) { zoneList = next || []; }

    // Which space a body is standing in, for the sanity meter and for the HUD. Floor 0 is "between
    // floors" — a stairwell or a moving cabin — and is never a room, so a camper cannot bank a meter
    // by standing on a landing.
    function floorOf(entry, lift) {
      let floor = 1;
      let best = Infinity;
      for (let id = 1; id <= player.floorCount; id += 1) {
        const diff = Math.abs(entry.y - (id - 1) * player.floorHeight);
        if (diff < best) { best = diff; floor = id; }
      }
      if (lift && lift.state === 'moving' && inCabin(entry)) return 0;
      if (best < 0.38) return floor;
      if (navigation && demonLogic && demonLogic.isInStairwell(entry, { navigation })) return 0;
      return floor;
    }

    function createState({ players = [], seekerId = null } = {}) {
      const roster = players.map((entry) => entry.id);
      const roundState = round.createRound({ players: roster, seekerId, config: roundConfig, random });
      const bodies = players.map((entry) => ({
        id: entry.id,
        x: entry.spawn.x, y: entry.spawn.y, z: entry.spawn.z,
        yaw: Number(entry.spawn.yaw) || 0,
        floor: entry.spawn.floor || 1,
        crouching: false,
        moving: false,
        interacting: false,
        stamina: stamina.createStaminaState(),
        flashlight: flashlight.createFlashlightState(false, 1),
        sanity: sanity.createPlayerSanity(entry.spawn),
      }));
      let fixtureState = fixtures ? fixtures.createFixtureState(catalog) : null;
      // The head start is physical from the first tick: the cabin is shut with the seeker inside it.
      if (fixtureState && roundState.phase === round.PHASES.HIDING) fixtureState = fixtures.holdElevator(fixtureState);
      if (fixtureState) fixtures.publishFixtures(fixtureState, { config: fixtureConfig, space });
      const demons = createDemons(bodies, roundState);
      return { tick: 0, elapsed: 0, round: roundState, bodies, fixtures: fixtureState, demons, pickups: [], events: [] };
    }

    // The map's demons, off one factory, spawned apart: each one is placed clear of the demons
    // already standing, so a roster of three opens as three separate threats rather than a pack.
    // Separation is a distance rather than a floor each, because Cinder Mall carries three demons on
    // two levels and a floor each has no answer there — see `chooseDemonSpawn`.
    //
    // Only one demon in a roster reads the sanity meter (`hunts`), and the catalog is where that is
    // decided — two camper-hunters would converge on the same full bar and read as a swarm.
    function createDemons(bodies, roundState) {
      if (!demonLogic || !enemy) return [];
      const seeker = round.seekerOf(roundState);
      const anchor = bodies.find((entry) => seeker && entry.id === seeker.id) || bodies[0] || { x: 0, z: 0, floor: 1 };
      const taken = [];
      return demonRoster.map((entry) => {
        const spawn = demonLogic.chooseDemonSpawn({
          enemy, player: anchor, players: bodies, random, taken: taken.slice(), navigation, config: demonConfig,
        });
        taken.push(spawn);
        return demonLogic.createDemon({ id: entry.id, name: entry.name, spawn, hunts: !!entry.hunts });
      });
    }

    function participantOf(state, id) {
      return round.participant(state.round, id);
    }

    function bodyOf(state, id) {
      return state.bodies.find((entry) => entry.id === id) || null;
    }

    // One body, one tick. The seeker is physically held for the head start, and the hold is applied
    // here rather than trusted to a client that could simply keep sending a direction.
    function stepBody(entry, input, delta, held, lift) {
      const command = readInput(input);
      const crouching = command.crouch;
      const wantMove = !held && !!(command.forward || command.strafe);
      const staminaState = stamina.updateStamina(entry.stamina, {
        delta,
        wantSprint: command.sprint,
        moving: wantMove,
        crouching,
        config: staminaConfig,
      });
      const speed = crouching ? player.crouchSpeed : staminaState.sprinting ? player.sprintSpeed : player.walkSpeed;
      let position = { x: entry.x, y: entry.y, z: entry.z };
      let moved = false;
      if (wantMove) {
        // The camera's forward is -Z rotated by yaw, and right is that turned a quarter clockwise.
        // The client sends the facing, not the vector, so the authority derives the same step.
        const forwardX = -Math.sin(command.yaw); const forwardZ = -Math.cos(command.yaw);
        const rightX = -forwardZ; const rightZ = forwardX;
        let dx = forwardX * command.forward + rightX * command.strafe;
        let dz = forwardZ * command.forward + rightZ * command.strafe;
        const length = Math.hypot(dx, dz);
        if (length > 1) { dx /= length; dz /= length; }
        const step = movement.stepAxes(space, body, position, dx * speed * delta, dz * speed * delta);
        position = { x: clean(step.x), y: clean(step.y), z: clean(step.z) };
        moved = step.moved;
      }
      // A body standing in the cabin rides it. The lift is authoritative over its passengers, which
      // is the only way two players in one elevator can agree about where they are.
      if (lift && lift.state === 'moving') {
        if (inCabin(position) && Math.abs(position.y - lift.y) < 0.9) position = { ...position, y: clean(lift.y) };
      }
      const lit = flashlight.tickFlashlight(flashlight.setFlashlight(entry.flashlight, command.light), delta, flashlightConfig);
      const floor = floorOf(position, lift);
      const pose = { id: entry.id, x: position.x, z: position.z, floor };
      return {
        ...entry,
        ...position,
        floor,
        yaw: command.yaw,
        crouching,
        moving: moved,
        interacting: command.interact,
        stamina: staminaState,
        flashlight: lit,
        sanity: sanity.updatePlayerSanity(entry.sanity, pose, zoneList, delta, sanityConfig),
      };
    }

    // Interaction is edge-triggered on the authority. A client that holds E must not strobe a door
    // open and shut sixty times a second, and a client that spams the message must not either.
    function resolveInteractions(state, bodies, events) {
      if (!fixtures || !catalog.length) return state.fixtures;
      let fixtureState = state.fixtures;
      for (const entry of bodies) {
        const previous = bodyOf(state, entry.id);
        if (!entry.interacting || (previous && previous.interacting)) continue;
        const participant = participantOf(state, entry.id);
        if (!participant || !participant.alive) continue;
        const item = fixtures.selectInteractable(catalog, entry, { config: fixtureConfig, elevatorY: fixtureState.elevator.y });
        if (!item) continue;
        const result = fixtures.applyInteraction(fixtureState, item, entry.id);
        fixtureState = result.state;
        if (result.event) events.push(result.event);
      }
      return fixtureState;
    }

    // Catch resolution, from positions, on the authority side. `canTag` is distance, then height,
    // then line of sight — and the sight test is the same AABB ray the demon uses, so a wall is a
    // wall for everybody.
    function resolveTags(state) {
      const seeker = round.seekerOf(state.round);
      if (!seeker || !seeker.alive || state.round.phase !== round.PHASES.SEEKING) return state.round;
      const seekerBody = bodyOf(state, seeker.id);
      if (!seekerBody) return state.round;
      let roundState = state.round;
      for (const target of round.livingHiders(roundState)) {
        const hiderBody = bodyOf(state, target.id);
        if (!hiderBody) continue;
        const occluded = space.sightBlocked
          ? space.sightBlocked(
            { x: seekerBody.x, y: seekerBody.y + 1.55, z: seekerBody.z },
            { x: hiderBody.x, y: hiderBody.y + (hiderBody.crouching ? 0.9 : 1.55), z: hiderBody.z },
          )
          : false;
        if (!round.canTag({ seeker: seekerBody, hider: hiderBody, occluded }, roundConfig)) continue;
        roundState = round.resolveTag(roundState, { seekerId: seeker.id, hiderId: target.id });
      }
      return roundState;
    }

    function livingBodies(state) {
      return state.bodies.filter((entry) => {
        const participant = participantOf(state, entry.id);
        return participant && participant.alive;
      });
    }

    // The hunt. Both demons walk, look and catch inside the authoritative tick; the client only ever
    // draws where they ended up.
    function tickDemons(state, delta, fixtureState, events) {
      if (!demonLogic || !state.demons.length) return { demons: state.demons, fixtures: fixtureState, round: state.round };
      const candidates = livingBodies(state).map((entry) => ({
        id: entry.id, x: entry.x, y: entry.y, z: entry.z, floor: entry.floor, crouching: entry.crouching,
      }));
      const huntCandidates = livingBodies(state).map((entry) => ({
        id: entry.id, x: entry.x, z: entry.z, floor: entry.floor,
        zone: entry.sanity.meter.zone, kind: entry.sanity.meter.kind, full: entry.sanity.meter.full,
      }));
      let doors = fixtureState;
      const hunted = new Set();
      const ctx = {
        space, movement, enemy, sanity, sanityConfig, random,
        candidates, huntCandidates, rooms, navigation, navigator, config: demonConfig,
        // A room with no door is open, not shut. While the hotel was the only building every room
        // had a leaf, so "no door record" could only mean a bad room number and answering `locked`
        // was the safe read. A mall's storefront is a glass shopfront with a framed opening and no
        // leaf at all, and calling that locked is a shop no demon ever patrols into.
        isRoomLocked: (roomNumber) => {
          const item = doorByRoom.get(roomNumber);
          if (!item) return false;
          const door = doors && doors.doors[item.id];
          return door ? !!door.locked : true;
        },
        openDoor: (roomNumber, options) => {
          const item = doorByRoom.get(roomNumber);
          if (item && doors) doors = fixtures.forceDoorOpen(doors, item, options);
        },
        openDoorAhead: (demon, target, options) => {
          if (!doors) return;
          const closed = demonDoorCatalog.filter((item) => {
            const door = doors.doors[item.id];
            return door && (!door.open || door.locked || Math.abs(door.angle - item.openAngle) > 0.01);
          });
          const item = demonLogic.selectBlockingDoor(demon, target, closed, demonConfig);
          if (item) doors = fixtures.forceDoorOpen(doors, item, options);
          return !!item && doors.doors[item.id].open && Math.abs(doors.doors[item.id].angle - item.openAngle) > 0.01;
        },
        setHunted: (target) => { if (target) hunted.add(target.id); },
        emit: (event) => events.push(event),
      };
      const demons = state.demons.map((entry) => demonLogic.tickDemon(entry, delta, ctx));
      let roundState = state.round;
      // The round does not care which demon caught you; `resolveDemonCatch` takes a player id and a
      // third demon would cost nothing here.
      for (const entry of demons) {
        for (const id of demonLogic.caughtBy(entry, candidates, demonConfig, space)) {
          const participant = round.participant(roundState, id);
          if (!participant || !participant.alive) continue;
          roundState = round.resolveDemonCatch(roundState, id);
          events.push({ type: 'demon-catch', demon: entry.name, playerId: id });
        }
      }
      return { demons, fixtures: doors, round: roundState, hunted };
    }

    // A caught player drops what is left of their battery where they fell, for hiders and the seeker
    // alike. A body on the floor is a resupply, and who reaches it first is resolved here rather than
    // announced — a dropped battery is a contested object exactly like a tag.
    function dropForEliminated(state, bodies, previousRound, roundState, pickups, events) {
      let next = pickups;
      for (const participant of roundState.participants) {
        const before = round.participant(previousRound, participant.id);
        if (!before || !before.alive || participant.alive) continue;
        const entry = bodies.find((candidate) => candidate.id === participant.id);
        if (!entry) continue;
        const drop = flashlight.createFlashlightDrop(entry.flashlight);
        if (!(drop.charge > 0)) continue;
        next = [...next, { id: `drop-${participant.id}-${state.tick}`, x: entry.x, y: entry.y, z: entry.z, floor: entry.floor, charge: drop.charge }];
        events.push({ type: 'flashlight-drop', playerId: participant.id, charge: drop.charge });
      }
      return next;
    }

    function collectPickups(bodies, roundState, pickups, events) {
      if (!pickups.length) return { bodies, pickups };
      const remaining = [];
      let claimed = bodies;
      for (const pickup of pickups) {
        let taker = -1;
        for (let index = 0; index < claimed.length; index += 1) {
          const entry = claimed[index];
          const participant = round.participant(roundState, entry.id);
          if (!participant || !participant.alive) continue;
          if (Math.abs(entry.y - pickup.y) > PICKUP_HEIGHT) continue;
          if (Math.hypot(entry.x - pickup.x, entry.z - pickup.z) > PICKUP_RADIUS) continue;
          if (entry.flashlight.charge >= 1) continue;
          taker = index;
          break;
        }
        if (taker < 0) { remaining.push(pickup); continue; }
        claimed = claimed.slice();
        claimed[taker] = { ...claimed[taker], flashlight: flashlight.addFlashlightCharge(claimed[taker].flashlight, pickup.charge) };
        events.push({ type: 'flashlight-pickup', playerId: claimed[taker].id, charge: pickup.charge });
      }
      return { bodies: claimed, pickups: remaining };
    }

    function tick(state, delta, inputs = {}) {
      const events = [];
      const seeker = round.seekerOf(state.round);
      const held = state.round.phase === round.PHASES.HIDING;
      const lift = state.fixtures ? state.fixtures.elevator : null;
      const bodies = state.bodies.map((entry) => {
        const participant = participantOf(state, entry.id);
        if (!participant || !participant.alive) return entry;
        const isHeldSeeker = held && !!seeker && seeker.id === entry.id;
        return stepBody(entry, inputs[entry.id], delta, isHeldSeeker, lift);
      });
      let fixtureState = resolveInteractions(state, bodies, events);
      if (fixtureState) fixtureState = fixtures.tickFixtures(fixtureState, delta, { config: fixtureConfig, space });
      const roundAfterClock = round.tickRound(state.round, delta, roundConfig);
      // Exactly one transition releases the lift, and it is the same one that ends the head start.
      if (fixtureState && held && roundAfterClock.phase === round.PHASES.SEEKING) {
        fixtureState = fixtures.releaseElevator(fixtureState);
        events.push({ type: 'seeker-released' });
      }
      const ticked = { ...state, tick: state.tick + 1, elapsed: clean(state.elapsed + delta), bodies, fixtures: fixtureState, round: roundAfterClock };
      const hunt = tickDemons(ticked, delta, fixtureState, events);
      const afterTags = resolveTags({ ...ticked, round: hunt.round });
      let pickups = dropForEliminated(ticked, bodies, state.round, afterTags, ticked.pickups, events);
      const collected = collectPickups(bodies, afterTags, pickups, events);
      return {
        ...ticked,
        bodies: collected.bodies,
        pickups: collected.pickups,
        fixtures: hunt.fixtures,
        demons: hunt.demons,
        hunted: hunt.hunted ? [...hunt.hunted] : [],
        round: afterTags,
        events,
      };
    }

    // Still here so a demon that is *not* in the tick — a local prototype, a test — can end a round
    // the same way. `settle()` remains the only place a round ends.
    function resolveDemonCatch(state, playerId) {
      return { ...state, round: round.resolveDemonCatch(state.round, playerId) };
    }

    function describePlayer(state, entry) {
      const participant = participantOf(state, entry.id);
      return {
        id: entry.id,
        role: participant ? participant.role : null,
        alive: participant ? participant.alive : false,
        caughtBy: participant ? participant.caughtBy || null : null,
        x: entry.x, y: entry.y, z: entry.z, yaw: clean(entry.yaw),
        floor: entry.floor,
        crouching: entry.crouching,
        moving: entry.moving,
        flashlight: flashlight.describeFlashlight(entry.flashlight),
        stamina: { value: clean(entry.stamina.value), sprinting: entry.stamina.sprinting, exhausted: entry.stamina.exhausted },
        sanity: { value: clean(entry.sanity.meter.value), full: entry.sanity.meter.full },
        hunted: Array.isArray(state.hunted) && state.hunted.includes(entry.id),
        keys: state.fixtures ? fixtures.keysOf(state.fixtures, entry.id) : [],
      };
    }

    // What goes on the wire: positions, facings, the meters a body wears, the fixtures a client has
    // to draw, and the demons. A demon's position is here because a body nobody can draw is not a
    // body — but its intent is not, and the HUD still gets one aggregated threat state, which is the
    // rule that removed the tracker minimap.
    function snapshot(state) {
      return {
        tick: state.tick,
        round: round.describeRound(state.round, roundConfig),
        players: state.bodies.map((entry) => describePlayer(state, entry)),
        fixtures: state.fixtures ? fixtures.describeFixtures(state.fixtures) : null,
        demons: state.demons.map((entry) => demonLogic.describeDemon(entry)),
        threat: enemy ? enemy.aggregateEnemyState(state.demons.map((entry) => ({ state: entry.awareness ? entry.awareness.state : 'roam', routePurpose: entry.routePurpose }))) : 'roam',
        pickups: state.pickups.map((entry) => ({ id: entry.id, x: entry.x, y: entry.y, z: entry.z, floor: entry.floor })),
        events: state.events || [],
      };
    }

    return { createState, tick, snapshot, resolveDemonCatch, setZones, bodyOf, catalog, PLAYER: player };
  }

  return { createPlanSpace, createSimulation, normalizeRoster, readInput, DEFAULT_DEMONS, MAX_DEMONS, NO_INPUT, PICKUP_RADIUS, PLAYER_DEFAULTS };
});
