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
  // `stamina-logic.js` / `sanity-logic.js` / `flashlight-logic.js`. This file is the one place they
  // are ticked together, so the same simulation runs in the browser and on the server with no
  // renderer in either.
  //
  // The rule that shapes all of it: a client sends what it is trying to do, never what happened. An
  // input carries a direction, a facing and three held keys. Whether you moved, whether your battery
  // is empty and whether you were tagged are answers this file gives — a client that says "I wasn't
  // caught" or "my light is full" is ignored, which is what makes this safe to run as the authority.
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
  });

  const NO_INPUT = Object.freeze({ forward: 0, strafe: 0, yaw: 0, crouch: false, sprint: false, light: false });

  const clean = (value) => Math.round(Number(value) * 1e6) / 1e6;

  // Only these fields are read off an input. Anything else a client attaches — a position, a charge,
  // an "I tagged them" — never reaches the state.
  function readInput(raw) {
    if (!raw) return NO_INPUT;
    const forward = Math.max(-1, Math.min(1, Number(raw.forward) || 0));
    const strafe = Math.max(-1, Math.min(1, Number(raw.strafe) || 0));
    const yaw = Number.isFinite(raw.yaw) ? Number(raw.yaw) : 0;
    return { forward, strafe, yaw, crouch: !!raw.crouch, sprint: !!raw.sprint, light: !!raw.light };
  }

  // The world the simulation walks, built straight off the plan. `modules/world.js` is the browser's
  // version of this — the same two questions, answered from the same records — and this is the one a
  // server uses. Doors are the only thing that moves, so the collider set is rebuilt when one does
  // and cached in between: resolving 700-odd boxes per query per body per tick is not a tick budget.
  function createPlanSpace({ plan, collision, hotel, config = {}, openings = {}, dynamicHeights = {} } = {}) {
    const groundSnap = config.groundSnap;
    const bodyHeight = config.bodyHeight;
    const playerRadius = config.playerRadius;
    const doorState = { ...openings };
    let cached = null;
    let rebuilds = 0;

    function colliders() {
      if (!cached) { cached = plan.resolveColliders(hotel, doorState); rebuilds += 1; }
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
      rebuilds: () => rebuilds,
      openings: () => ({ ...doorState }),
      setDynamicHeight(id, value) { dynamicHeights[id] = value; },
      groundAt: (x, z, fromY) => plan.walkHeightAt(hotel.surfaces, x, z, fromY, groundSnap, dynamicHeights),
      blocked: (x, z, feetY, height = bodyHeight, radius = playerRadius) =>
        collision.collidesAt(colliders(), { x, z, feetY, bodyHeight: height, radius }),
      sightBlocked: (from, to, options) => collision.segmentBlocked(colliders(), from, to, options),
    };
  }

  function createSimulation({ movement, round, stamina, flashlight, sanity, space, zones = [], config = {} } = {}) {
    const player = { ...PLAYER_DEFAULTS, ...(config.player || {}) };
    const roundConfig = config.round;
    const flashlightConfig = config.flashlight;
    const staminaConfig = config.stamina;
    const sanityConfig = config.sanity;
    const body = { height: player.bodyHeight, radius: player.playerRadius };
    let zoneList = zones;

    function setZones(next) { zoneList = next || []; }

    function createState({ players = [], seekerId = null } = {}) {
      const roster = players.map((entry) => entry.id);
      const roundState = round.createRound({ players: roster, seekerId, config: roundConfig });
      const bodies = players.map((entry) => ({
        id: entry.id,
        x: entry.spawn.x, y: entry.spawn.y, z: entry.spawn.z,
        yaw: Number(entry.spawn.yaw) || 0,
        floor: entry.spawn.floor || 1,
        crouching: false,
        moving: false,
        stamina: stamina.createStaminaState(),
        flashlight: flashlight.createFlashlightState(false, 1),
        sanity: sanity.createPlayerSanity(entry.spawn),
      }));
      return { tick: 0, elapsed: 0, round: roundState, bodies };
    }

    function participantOf(state, id) {
      return round.participant(state.round, id);
    }

    function bodyOf(state, id) {
      return state.bodies.find((entry) => entry.id === id) || null;
    }

    // One body, one tick. The seeker is physically held for the head start, and the hold is applied
    // here rather than trusted to a client that could simply keep sending a direction.
    function stepBody(entry, input, delta, held) {
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
      const lit = flashlight.tickFlashlight(flashlight.setFlashlight(entry.flashlight, command.light), delta, flashlightConfig);
      const pose = { id: entry.id, x: position.x, z: position.z, floor: entry.floor };
      return {
        ...entry,
        ...position,
        yaw: command.yaw,
        crouching,
        moving: moved,
        stamina: staminaState,
        flashlight: lit,
        sanity: sanity.updatePlayerSanity(entry.sanity, pose, zoneList, delta, sanityConfig),
      };
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

    function tick(state, delta, inputs = {}) {
      const seeker = round.seekerOf(state.round);
      const held = state.round.phase === round.PHASES.HIDING;
      const bodies = state.bodies.map((entry) => {
        const participant = participantOf(state, entry.id);
        if (!participant || !participant.alive) return entry;
        const isHeldSeeker = held && !!seeker && seeker.id === entry.id;
        return stepBody(entry, inputs[entry.id], delta, isHeldSeeker);
      });
      const ticked = {
        ...state,
        tick: state.tick + 1,
        elapsed: clean(state.elapsed + delta),
        bodies,
        round: round.tickRound(state.round, delta, roundConfig),
      };
      return { ...ticked, round: resolveTags(ticked) };
    }

    // The demon is not simulated here yet: online rounds open with the hotel empty of them, and the
    // hunt arrives when the demon's navigation follows movement-logic out of `modules/monster.js`.
    // The ending it causes is already wired, so nothing downstream changes when it does.
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
        crouching: entry.crouching,
        moving: entry.moving,
        flashlight: flashlight.describeFlashlight(entry.flashlight),
        stamina: { value: clean(entry.stamina.value), sprinting: entry.stamina.sprinting, exhausted: entry.stamina.exhausted },
        sanity: { value: clean(entry.sanity.meter.value), full: entry.sanity.meter.full },
      };
    }

    // What goes on the wire: positions, facings and the meters a body wears — never a demon's
    // position and never another player's route, which is the same rule that keeps the HUD honest.
    function snapshot(state) {
      return {
        tick: state.tick,
        round: round.describeRound(state.round, roundConfig),
        players: state.bodies.map((entry) => describePlayer(state, entry)),
      };
    }

    return { createState, tick, snapshot, resolveDemonCatch, setZones, bodyOf, PLAYER: player };
  }

  return { createPlanSpace, createSimulation, readInput, NO_INPUT, PLAYER_DEFAULTS };
});
