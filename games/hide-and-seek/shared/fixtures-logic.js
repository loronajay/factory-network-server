(function attachHotelFixtures(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelFixtures = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelFixturesApi() {
  'use strict';

  // Everything in the hotel a player can operate: room doors, secret panels, drawers, the keys they
  // hold, and the elevator. It is all pure, because online every one of them is **contested state** —
  // a door you opened has to be open for the seeker chasing you, a drawer holds one key and only the
  // first person to search it gets it, and the elevator carries whoever is standing in it.
  //
  // Before this file the renderer owned all of it, which is why online play had a hotel where a door
  // another player opened was still shut for you and the server never knew. The rule is the same one
  // that moved the building into `hotel-plan.js`: if only a browser can say whether a door is open,
  // only a browser can say who was caught behind it.
  //
  // Interaction targeting is here too, and deliberately not a raycast. The client aims with a
  // `THREE.Raycaster` against meshes; the authority aims with distance, height and a facing dot
  // against plain records. A client sends "I pressed E", never "I opened door-201".

  const FIXTURE_KINDS = Object.freeze({
    DOOR: 'door', PANEL: 'panel', DRAWER: 'drawer',
    ELEVATOR_CALL: 'elevator-call', ELEVATOR_BUTTON: 'elevator-button',
  });

  const ELEVATOR_STATES = Object.freeze({
    OPEN: 'open', OPENING: 'opening', CLOSING: 'closing', MOVING: 'moving', HELD: 'round-hold',
  });

  const FIXTURE_DEFAULTS = Object.freeze({
    reachDistance: 3,
    // A fixture on the floor above must not be reachable through the ceiling.
    reachHeight: 2.4,
    // Roughly a 110-degree cone in front of the player. Wide enough that aiming is not a chore,
    // narrow enough that walking past a drawer does not open it.
    facingDot: 0.35,
    doorSpeed: 5.2,
    drawerSpeed: 2.4,
    doorOpenAngle: Math.PI / 2,
    elevatorSpeed: 2.15,
    elevatorDoorSpeed: 1.35,
    elevatorCenterX: 2.5,
    elevatorCenterZ: 57.45,
    floorHeight: 4.6,
    // The cabin's dimensions, which the renderer draws and the authority has to collide.
    cabinWidth: 2.5,
    cabinDepth: 3.2,
    cabinHeight: 2.65,
  });

  function settings(config) {
    return config ? { ...FIXTURE_DEFAULTS, ...config } : FIXTURE_DEFAULTS;
  }

  const round6 = (value) => Math.round(Number(value) * 1e6) / 1e6;

  // --- the catalog ------------------------------------------------------------------------------

  // One flat list of operable things, built off the plan once. Positions are world space, so the same
  // record answers "can this player reach it" on the server and "what should the prompt say" in the
  // browser.
  function createFixtureCatalog(hotel, { floorY, config } = {}) {
    const cfg = settings(config);
    const yOf = typeof floorY === 'function' ? floorY : (floor) => (floor - 1) * cfg.floorHeight;
    const items = [];
    for (const door of hotel.roomDoors) {
      items.push({
        id: door.id, kind: FIXTURE_KINDS.DOOR, floor: door.floor, roomNumber: door.roomNumber,
        x: door.x, y: yOf(door.floor), z: door.z, openAngle: door.openAngle,
        locked: !!door.locked, requiredKey: door.requiredKey || null, openInitially: !!door.openInitially,
      });
    }
    for (const panel of hotel.secretPanels) {
      items.push({
        id: panel.id, kind: FIXTURE_KINDS.PANEL, floor: panel.floor,
        x: panel.x, y: yOf(panel.floor), z: panel.z, openAngle: panel.openAngle,
      });
    }
    for (const placement of hotel.furnishings) {
      if (placement.type !== 'dresser') continue;
      items.push({
        id: placement.id, kind: FIXTURE_KINDS.DRAWER, floor: placement.floor,
        x: placement.x, y: placement.y, z: placement.z,
        keyId: placement.keyId || null, keyLabel: placement.keyLabel || placement.keyId || null,
        label: placement.label || 'drawer',
      });
    }
    for (const box of hotel.boxes) {
      if (box.kind !== 'call-button') continue;
      items.push({
        id: 'elevator-call-' + box.callFloor, kind: FIXTURE_KINDS.ELEVATOR_CALL,
        floor: box.floor, callFloor: box.callFloor, x: box.x, y: box.y, z: box.z,
      });
    }
    // The cabin buttons ride the car, so their height is state rather than layout. They carry a
    // local Y and are resolved against the car whenever a reach is tested.
    for (let floor = 1; floor <= 4; floor += 1) {
      items.push({
        id: 'elevator-button-' + floor, kind: FIXTURE_KINDS.ELEVATOR_BUTTON, floor: null, callFloor: floor,
        x: cfg.elevatorCenterX, localY: 0.72 + (floor - 1) * 0.35, z: cfg.elevatorCenterZ + 0.25,
        y: 0, inCabin: true,
      });
    }
    return items;
  }

  // --- state ------------------------------------------------------------------------------------

  function createFixtureState(catalog) {
    const doors = {};
    const drawers = {};
    for (const item of catalog) {
      if (item.kind === FIXTURE_KINDS.DOOR) {
        const open = !!item.openInitially;
        doors[item.id] = { angle: open ? item.openAngle : 0, target: open ? item.openAngle : 0, open, locked: !!item.locked, discovered: true };
      } else if (item.kind === FIXTURE_KINDS.PANEL) {
        doors[item.id] = { angle: 0, target: 0, open: false, locked: false, discovered: false };
      } else if (item.kind === FIXTURE_KINDS.DRAWER) {
        drawers[item.id] = { open: false, amount: 0, searched: false, emptied: false };
      }
    }
    return {
      doors,
      drawers,
      keys: {},
      elevator: {
        floor: 1, targetFloor: 1, state: ELEVATOR_STATES.OPEN, doorAmount: 1,
        y: 0, held: false, pendingCall: null, passenger: false,
      },
    };
  }

  // The seeker's head start, made physical: the cabin is shut with them inside it, and neither a call
  // button nor a cabin button answers until the round releases it.
  function holdElevator(state) {
    return {
      ...state,
      elevator: {
        ...state.elevator, floor: 1, targetFloor: 1, state: ELEVATOR_STATES.HELD,
        doorAmount: 0, y: 0, held: true, pendingCall: null, passenger: false,
      },
    };
  }

  function releaseElevator(state) {
    if (!state.elevator.held) return state;
    return { ...state, elevator: { ...state.elevator, held: false, state: ELEVATOR_STATES.OPENING } };
  }

  function keysOf(state, playerId) {
    return state.keys[playerId] || [];
  }

  // --- targeting --------------------------------------------------------------------------------

  function reachY(item, elevatorY) {
    return item.inCabin ? elevatorY + item.localY : item.y;
  }

  // Distance, then height, then facing — the same ordering `canTag` uses, and for the same reason:
  // the cheap rejections come first, because this runs for every player who presses a key.
  function selectInteractable(catalog, viewer, { config, elevatorY = 0 } = {}) {
    const cfg = settings(config);
    // The camera's forward is -Z rotated by yaw, exactly as the mover derives it.
    const forwardX = -Math.sin(viewer.yaw || 0);
    const forwardZ = -Math.cos(viewer.yaw || 0);
    let best = null;
    let bestDistance = Infinity;
    for (const item of catalog) {
      const dx = item.x - viewer.x;
      const dz = item.z - viewer.z;
      const distance = Math.hypot(dx, dz);
      if (distance > cfg.reachDistance || distance <= 0) continue;
      if (Math.abs(reachY(item, elevatorY) - (viewer.y || 0)) > cfg.reachHeight) continue;
      if ((dx * forwardX + dz * forwardZ) / distance < cfg.facingDot) continue;
      if (distance < bestDistance) { best = item; bestDistance = distance; }
    }
    return best;
  }

  // --- interaction ------------------------------------------------------------------------------

  function withDoor(state, id, patch) {
    return { ...state, doors: { ...state.doors, [id]: { ...state.doors[id], ...patch } } };
  }

  function swingDoor(state, item, open) {
    return withDoor(state, item.id, { open, target: open ? item.openAngle : 0 });
  }

  function operateDoor(state, item, playerId) {
    const door = state.doors[item.id];
    if (!door) return { state, event: null };
    if (door.locked) {
      if (!item.requiredKey || !keysOf(state, playerId).includes(item.requiredKey)) {
        return { state, event: { type: 'door-locked', id: item.id, roomNumber: item.roomNumber, requiredKey: item.requiredKey, playerId } };
      }
      const unlocked = withDoor(state, item.id, { locked: false });
      return {
        state: swingDoor(unlocked, item, true),
        event: { type: 'door-unlocked', id: item.id, roomNumber: item.roomNumber, keyId: item.requiredKey, playerId },
      };
    }
    return {
      state: swingDoor(state, item, !door.open),
      event: { type: door.open ? 'door-closed' : 'door-opened', id: item.id, roomNumber: item.roomNumber, playerId },
    };
  }

  // A panel is found before it is used: the first press is the discovery and swings it open, and
  // every press after that is an ordinary door.
  function operatePanel(state, item, playerId) {
    const panel = state.doors[item.id];
    if (!panel) return { state, event: null };
    if (!panel.discovered) {
      return {
        state: withDoor(state, item.id, { discovered: true, open: true, target: item.openAngle }),
        event: { type: 'secret-discovered', id: item.id, floor: item.floor, playerId },
      };
    }
    return {
      state: swingDoor(state, item, !panel.open),
      event: { type: panel.open ? 'secret-closed' : 'secret-opened', id: item.id, floor: item.floor, playerId },
    };
  }

  // Open, then search, then close — and the key inside is claimed exactly once. Whoever presses
  // second finds an empty drawer, which is the whole reason this decision belongs to the authority.
  function operateDrawer(state, item, playerId) {
    const drawer = state.drawers[item.id];
    if (!drawer) return { state, event: null };
    if (!drawer.open) {
      return {
        state: { ...state, drawers: { ...state.drawers, [item.id]: { ...drawer, open: true } } },
        event: { type: 'drawer-opened', id: item.id, playerId },
      };
    }
    if (!drawer.searched) {
      const claimed = !!item.keyId && !drawer.emptied;
      const drawers = { ...state.drawers, [item.id]: { ...drawer, searched: true, emptied: true } };
      if (!claimed) return { state: { ...state, drawers }, event: { type: 'drawer-empty', id: item.id, playerId } };
      const held = keysOf(state, playerId);
      const keys = held.includes(item.keyId) ? state.keys : { ...state.keys, [playerId]: [...held, item.keyId] };
      return {
        state: { ...state, drawers, keys },
        event: { type: 'key-found', id: item.id, keyId: item.keyId, keyLabel: item.keyLabel, playerId },
      };
    }
    // Closing resets the search but not the contents: the next player gets to look, and finds the
    // drawer someone already emptied.
    return {
      state: { ...state, drawers: { ...state.drawers, [item.id]: { ...drawer, open: false, searched: false } } },
      event: { type: 'drawer-closed', id: item.id, playerId },
    };
  }

  function callElevator(state, floor) {
    const lift = state.elevator;
    if (lift.held) return { state, event: { type: 'elevator-held' } };
    if (lift.state === ELEVATOR_STATES.MOVING || lift.state === ELEVATOR_STATES.CLOSING) {
      return { state: { ...state, elevator: { ...lift, pendingCall: floor } }, event: { type: 'elevator-queued', floor } };
    }
    if (lift.floor === floor) {
      return { state: { ...state, elevator: { ...lift, targetFloor: floor, state: ELEVATOR_STATES.OPENING } }, event: null };
    }
    return {
      state: { ...state, elevator: { ...lift, targetFloor: floor, passenger: false, state: ELEVATOR_STATES.CLOSING } },
      event: { type: 'elevator-called', floor },
    };
  }

  function pressElevatorButton(state, floor) {
    const lift = state.elevator;
    if (lift.held || lift.state === ELEVATOR_STATES.MOVING || lift.state === ELEVATOR_STATES.CLOSING) return { state, event: null };
    if (lift.floor === floor) return { state: { ...state, elevator: { ...lift, state: ELEVATOR_STATES.OPENING } }, event: null };
    return {
      state: { ...state, elevator: { ...lift, targetFloor: floor, passenger: true, state: ELEVATOR_STATES.CLOSING } },
      event: { type: 'elevator-selected', floor },
    };
  }

  // One press, one fixture. Returns the new state and what happened, so a HUD can narrate it without
  // the caller re-deriving which branch was taken.
  function applyInteraction(state, item, playerId) {
    if (!item) return { state, event: null };
    if (item.kind === FIXTURE_KINDS.DOOR) return operateDoor(state, item, playerId);
    if (item.kind === FIXTURE_KINDS.PANEL) return operatePanel(state, item, playerId);
    if (item.kind === FIXTURE_KINDS.DRAWER) return operateDrawer(state, item, playerId);
    if (item.kind === FIXTURE_KINDS.ELEVATOR_CALL) return callElevator(state, item.callFloor);
    if (item.kind === FIXTURE_KINDS.ELEVATOR_BUTTON) return pressElevatorButton(state, item.callFloor);
    return { state, event: null };
  }

  // The demon does not knock. Hunting a camper it unlocks the door and swings it; roaming it only
  // opens one that was already unlocked.
  function forceDoorOpen(state, item, { unlock = false } = {}) {
    const door = item && state.doors[item.id];
    if (!door) return state;
    if (door.locked && !unlock) return state;
    if (door.open && !door.locked) return state;
    return withDoor(state, item.id, { locked: door.locked && !unlock, open: true, target: item.openAngle, discovered: true });
  }

  // --- the tick ---------------------------------------------------------------------------------

  function approach(current, target, rate, delta) {
    const diff = target - current;
    if (Math.abs(diff) < 1e-4) return target;
    return current + Math.sign(diff) * Math.min(Math.abs(diff), rate * delta);
  }

  function tickDoors(state, delta, cfg, space) {
    let doors = null;
    for (const id of Object.keys(state.doors)) {
      const door = state.doors[id];
      const angle = round6(approach(door.angle, door.target, cfg.doorSpeed, delta));
      if (angle === door.angle) continue;
      if (!doors) doors = { ...state.doors };
      doors[id] = { ...door, angle };
      // The space rebuilds its collider list only when this actually changes something, so a door
      // that has finished swinging costs nothing.
      if (space && space.setOpening) space.setOpening(id, angle);
    }
    return doors ? { ...state, doors } : state;
  }

  function tickDrawers(state, delta, cfg) {
    let drawers = null;
    for (const id of Object.keys(state.drawers)) {
      const drawer = state.drawers[id];
      const amount = round6(approach(drawer.amount, drawer.open ? 1 : 0, cfg.drawerSpeed, delta));
      if (amount === drawer.amount) continue;
      if (!drawers) drawers = { ...state.drawers };
      drawers[id] = { ...drawer, amount };
    }
    return drawers ? { ...state, drawers } : state;
  }

  function floorYFor(floor, cfg) {
    return (floor - 1) * cfg.floorHeight;
  }

  // The cabin is the one collider that is state rather than layout: it rides the shaft, so its boxes
  // are recomputed from the car's height every time it moves.
  function elevatorColliders(lift, config) {
    const cfg = settings(config);
    const cx = cfg.elevatorCenterX;
    const cz = cfg.elevatorCenterZ;
    const half = cfg.cabinWidth / 2;
    const frontZ = cz - cfg.cabinDepth / 2;
    const boxes = [
      { id: 'elevator-cabin-left', minX: cx - half - 0.06, maxX: cx - half + 0.06, minY: lift.y, maxY: lift.y + cfg.cabinHeight, minZ: frontZ, maxZ: cz + cfg.cabinDepth / 2 },
      { id: 'elevator-cabin-right', minX: cx + half - 0.06, maxX: cx + half + 0.06, minY: lift.y, maxY: lift.y + cfg.cabinHeight, minZ: frontZ, maxZ: cz + cfg.cabinDepth / 2 },
      { id: 'elevator-cabin-back', minX: cx - half, maxX: cx + half, minY: lift.y, maxY: lift.y + cfg.cabinHeight, minZ: cz + cfg.cabinDepth / 2 - 0.06, maxZ: cz + cfg.cabinDepth / 2 + 0.06 },
    ];
    // Doors mostly open have stopped being an obstacle — the same 0.62 threshold the hall doors use.
    if (lift.doorAmount < 0.62) {
      for (const side of [-1, 1]) {
        const offset = cx + side * (0.46 + (1.72 - 0.46) * lift.doorAmount);
        boxes.push({
          id: 'elevator-cabin-door-' + (side < 0 ? 'left' : 'right'),
          minX: offset - 0.46, maxX: offset + 0.46,
          minY: lift.y, maxY: lift.y + 2.35,
          minZ: frontZ - 0.06, maxZ: frontZ + 0.06,
        });
      }
    }
    return boxes;
  }

  function publishElevator(lift, cfg, space) {
    if (!space) return;
    if (space.setDynamicHeight) space.setDynamicHeight('elevator-car', lift.y);
    if (space.setOpening) {
      // Only the floor the cabin is standing at has its hall doors open; every other floor's opening
      // onto the shaft stays shut whatever the cabin is doing.
      for (let floor = 1; floor <= 4; floor += 1) {
        const amount = floor === lift.floor && lift.state !== ELEVATOR_STATES.MOVING ? lift.doorAmount : 0;
        space.setOpening('hall-door-' + floor + '-left', amount);
        space.setOpening('hall-door-' + floor + '-right', amount);
      }
    }
    if (space.setDynamicBoxes) space.setDynamicBoxes(elevatorColliders(lift, cfg));
  }

  function tickElevator(state, delta, cfg, space) {
    const lift = state.elevator;
    if (lift.state === ELEVATOR_STATES.HELD) return state;
    const epsilon = 0.005;
    let next = lift;
    if (lift.state === ELEVATOR_STATES.CLOSING) {
      const doorAmount = Math.max(0, lift.doorAmount - cfg.elevatorDoorSpeed * delta);
      next = doorAmount <= epsilon
        ? { ...lift, doorAmount: 0, state: ELEVATOR_STATES.MOVING }
        : { ...lift, doorAmount };
    } else if (lift.state === ELEVATOR_STATES.MOVING) {
      const targetY = floorYFor(lift.targetFloor, cfg);
      const y = round6(approach(lift.y, targetY, cfg.elevatorSpeed, delta));
      next = Math.abs(targetY - y) < 0.008
        ? { ...lift, y: targetY, floor: lift.targetFloor, state: ELEVATOR_STATES.OPENING, passenger: false }
        : { ...lift, y };
    } else if (lift.state === ELEVATOR_STATES.OPENING) {
      const doorAmount = Math.min(1, lift.doorAmount + cfg.elevatorDoorSpeed * delta);
      if (doorAmount < 1 - epsilon) next = { ...lift, doorAmount };
      else {
        next = { ...lift, doorAmount: 1, state: ELEVATOR_STATES.OPEN };
        if (lift.pendingCall !== null && lift.pendingCall !== lift.floor) {
          next = { ...next, targetFloor: lift.pendingCall, pendingCall: null, passenger: false, state: ELEVATOR_STATES.CLOSING };
        }
      }
    }
    if (next === lift) return state;
    publishElevator(next, cfg, space);
    return { ...state, elevator: next };
  }

  function tickFixtures(state, delta, { config, space } = {}) {
    if (!(delta > 0)) return state;
    const cfg = settings(config);
    let next = tickDoors(state, delta, cfg, space);
    next = tickDrawers(next, delta, cfg);
    return tickElevator(next, delta, cfg, space);
  }

  // Seed a space with the fixture state as it currently stands. Called once when a round starts, so
  // an initially-open door is open for collision before the first tick rather than a frame later.
  function publishFixtures(state, { config, space } = {}) {
    if (!space) return;
    const cfg = settings(config);
    if (space.setOpening) for (const id of Object.keys(state.doors)) space.setOpening(id, state.doors[id].angle);
    publishElevator(state.elevator, cfg, space);
  }

  // What goes on the wire. Only what a client has to draw: a swing angle for each door that is not
  // still shut and untouched, a drawer that has been opened, and the cabin. Publishing every door
  // would be a wallhack for the locked rooms nobody has opened yet, and it is also most of the bytes.
  function describeFixtures(state) {
    const doors = {};
    for (const id of Object.keys(state.doors)) {
      const door = state.doors[id];
      if (door.angle === 0 && !door.open && !door.discovered) continue;
      doors[id] = round6(door.angle);
    }
    const drawers = {};
    for (const id of Object.keys(state.drawers)) {
      const drawer = state.drawers[id];
      if (drawer.amount === 0 && !drawer.searched) continue;
      drawers[id] = { amount: round6(drawer.amount), searched: !!drawer.searched };
    }
    return {
      doors, drawers,
      elevator: {
        floor: state.elevator.floor, targetFloor: state.elevator.targetFloor, state: state.elevator.state,
        doorAmount: round6(state.elevator.doorAmount), y: round6(state.elevator.y),
      },
    };
  }

  return {
    ELEVATOR_STATES, FIXTURE_DEFAULTS, FIXTURE_KINDS,
    applyInteraction, callElevator, createFixtureCatalog, createFixtureState, describeFixtures,
    elevatorColliders, forceDoorOpen, keysOf, holdElevator, pressElevatorButton, publishFixtures,
    releaseElevator, selectInteractable, tickFixtures,
  };
});
