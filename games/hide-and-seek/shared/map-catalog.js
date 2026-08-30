(function attachHotelMaps(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelMaps = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelMapsApi(root) {
  'use strict';

  // The buildings, as a registry.
  //
  // The hotel used to be the only place a round could happen, so "the map" was spelled several
  // different ways at once: `hotel-plan.js` was the building, `FLOOR_DEFS` was how many floors there
  // were, and the demon roster was two names hard-coded in `modules/demons.js` and again in
  // `sim-logic.js`. Adding a second location would have meant editing all three and hoping they
  // agreed.
  //
  // So this file is the one answer to "which places exist, and what is in them". A map descriptor
  // carries three things nothing else may re-derive:
  //
  //   * where its geometry comes from — a plan factory named by the global it attaches to, so a new
  //     location is a new pure file plus a row here and nothing else;
  //   * how tall it is — `floorCount`, which the demon navigation, the stair layout and the sanity
  //     floor lookup all read instead of assuming four;
  //   * who hunts in it — the demon roster, which is per map and any length. Two was never a rule,
  //     it was just how many the hotel had.
  //
  // It is pure and mirrored to the server, because the authority has to agree with the client about
  // which building a round is happening in and how many things are hunting in it.

  const MAP_STATUS = Object.freeze({
    // Its plan exists and a round can be played in it.
    READY: 'ready',
    // Registered, named, and not yet buildable. A `soon` map is offered in the picker as a locked
    // row rather than hidden, and is never resolved into a plan.
    SOON: 'soon',
  });

  // Exactly one demon per map reads the sanity meter. The anti-camping rule has to read as one
  // stalker walking to the room you would not leave; two of them converging on the same full bar is
  // a swarm, and a swarm is not a threat you can learn.
  const HOTEL_DEMONS = Object.freeze([
    Object.freeze({
      id: 'bellhop', name: 'The Bellhop', hunts: true,
      statusElementId: 'monsterStatus', accentColor: 0x5c141a, eyeColor: 0xff1008,
    }),
    Object.freeze({
      id: 'housekeeper', name: 'The Housekeeper', hunts: false,
      statusElementId: 'housekeeperStatus', accentColor: 0x285f58, eyeColor: 0x7dffe0,
    }),
  ]);

  // Cinder Mall's staff. Three of them, which is the whole reason the roster is data: nothing below
  // this line had to change to add a third body to a building.
  const MALL_DEMONS = Object.freeze([
    Object.freeze({ id: 'greeter', name: 'The Greeter', hunts: true, accentColor: 0x7a2a12, eyeColor: 0xffb020 }),
    Object.freeze({ id: 'custodian', name: 'The Custodian', hunts: false, accentColor: 0x1f4a2e, eyeColor: 0x8dff9a }),
    Object.freeze({ id: 'nightwatch', name: 'The Nightwatch', hunts: false, accentColor: 0x22305e, eyeColor: 0x7fb4ff }),
  ]);

  const HOSPITAL_DEMONS = Object.freeze([
    Object.freeze({ id: 'surgeon', name: 'The Surgeon', hunts: true, accentColor: 0x315951, eyeColor: 0x9bffe1 }),
    Object.freeze({ id: 'matron', name: 'The Matron', hunts: false, accentColor: 0x722837, eyeColor: 0xff6677 }),
    Object.freeze({ id: 'orderly', name: 'The Orderly', hunts: false, accentColor: 0x45566c, eyeColor: 0x98cfff }),
  ]);

  const MAPS = Object.freeze([
    Object.freeze({
      id: 'grand-hotel',
      name: 'The Grand Hotel',
      eyebrow: 'FOUR FLOORS',
      blurb: 'Guest rooms, a continuous stairwell and one working elevator.',
      status: MAP_STATUS.READY,
      floorCount: 4,
      // `floorDefsKey: null` means "the floor definitions this cabinet already ships" — the hotel is
      // the map `modules/game-config.js` was written for, and moving FLOOR_DEFS in here would put a
      // second copy of the hotel in the repo.
      plan: Object.freeze({ global: 'HotelPlan', factory: 'createHotelPlan', floorDefsKey: null }),
      demons: HOTEL_DEMONS,
    }),
    Object.freeze({
      id: 'cinder-mall',
      name: 'Cinder Mall',
      eyebrow: 'TWO LEVELS',
      blurb: 'A burnt-out shopping centre. Three of the staff are still on shift.',
      status: MAP_STATUS.READY,
      // Two levels and three demons, which is the combination that proved the roster is really data:
      // the hotel spread its two by giving each one a floor, and that arithmetic has no answer here.
      // A mall separates them sideways instead — the building is 96m across — so `chooseDemonSpawn`
      // measures distance rather than counting storeys.
      floorCount: 2,
      plan: Object.freeze({ global: 'MallPlan', factory: 'createMallPlan', floorDefsKey: 'FLOOR_DEFS' }),
      demons: MALL_DEMONS,
    }),
    Object.freeze({
      id: 'mercy-hospital',
      name: 'Mercy Hospital',
      eyebrow: 'TWO FLOORS',
      blurb: 'Fourteen departments, a service stairwell, and three staff who never clocked out.',
      status: MAP_STATUS.READY,
      floorCount: 2,
      plan: Object.freeze({ global: 'HospitalPlan', factory: 'createHospitalPlan', floorDefsKey: 'FLOOR_DEFS' }),
      demons: HOSPITAL_DEMONS,
    }),
    Object.freeze({
      id: 'crowne-point-cinema', name: 'Crowne Point Cinema', eyebrow: 'SIX SCREENS · TWO FLOORS',
      blurb: 'Dark auditoriums, looping service aisles and projection booths. Two staff remain after the final showing.',
      status: MAP_STATUS.READY, floorCount: 2,
      plan: Object.freeze({ global: 'CinemaPlan', factory: 'createCinemaPlan', floorDefsKey: 'FLOOR_DEFS' }),
      demons: Object.freeze([
        Object.freeze({ id: 'usher', name: 'The Usher', hunts: true, accentColor: 0x702331, eyeColor: 0xffba66 }),
        Object.freeze({ id: 'projectionist', name: 'The Projectionist', hunts: false, accentColor: 0x294755, eyeColor: 0x98e5ff }),
      ]),
    }),
  ]);

  const DEFAULT_MAP_ID = MAPS[0].id;

  const listMaps = () => MAPS.slice();
  const getMap = (id) => MAPS.find((entry) => entry.id === id) || null;
  const isPlayable = (id) => getMap(id)?.status === MAP_STATUS.READY;

  // A map id off a query string, a saved preference or a lobby setting is untrusted text. This is
  // the only place it becomes a map.
  function normalizeMapId(id) {
    const text = typeof id === 'string' ? id.trim().toLowerCase() : '';
    return getMap(text) ? text : DEFAULT_MAP_ID;
  }

  // What a round may actually be held in. A registered-but-unbuilt map normalizes fine — the picker
  // wants to show it — but never reaches a simulation, on either side of the wire.
  function playableMapId(id) {
    const mapId = normalizeMapId(id);
    return isPlayable(mapId) ? mapId : DEFAULT_MAP_ID;
  }

  const playableMaps = () => MAPS.filter((entry) => entry.status === MAP_STATUS.READY);
  // These describe a map, so they answer for an unbuilt one too — the picker has to be able to say
  // "Cinder Mall, three levels, three demons" before its plan exists. Anything standing a round up
  // passes an id through `playableMapId` first.
  const demonRosterFor = (id) => getMap(normalizeMapId(id)).demons.slice();
  const demonCountFor = (id) => demonRosterFor(id).length;
  const floorCountFor = (id) => getMap(normalizeMapId(id)).floorCount;

  // Turn a map into a building. The plan factory is named rather than imported because the pure
  // layer loads as classic scripts in the browser and as side-effect imports on the server: in both
  // it is a global by the time anything asks for a round.
  function planApiFor(map, scope) {
    const planApi = scope ? scope[map.plan.global] : null;
    if (!planApi || typeof planApi[map.plan.factory] !== 'function') {
      throw new Error(`Map "${map.id}" has no plan: ${map.plan.global}.${map.plan.factory} is not loaded`);
    }
    return planApi;
  }

  // A map's floor definitions. The hotel's live in `modules/game-config.js` and are passed in; a map
  // that ships its own building brings its own, off its plan module. The renderer needs these
  // separately from the plan because it builds one scene group per floor before it draws anything.
  function resolveMapFloorDefs(id, { floorDefs, scope = root } = {}) {
    const map = getMap(playableMapId(id));
    if (!map.plan.floorDefsKey) return floorDefs;
    return planApiFor(map, scope)[map.plan.floorDefsKey];
  }

  function resolveMapPlan(id, { config, floorDefs, layout, floorY, keyIdForFloor, keyLabelForFloor, scope = root } = {}) {
    const map = getMap(playableMapId(id));
    const planApi = planApiFor(map, scope);
    const defs = map.plan.floorDefsKey ? planApi[map.plan.floorDefsKey] : floorDefs;
    return planApi[map.plan.factory]({ config, floorDefs: defs, layout, floorY, keyIdForFloor, keyLabelForFloor });
  }

  return {
    DEFAULT_MAP_ID, MAPS, MAP_STATUS,
    demonCountFor, demonRosterFor, floorCountFor, getMap, isPlayable,
    listMaps, normalizeMapId, playableMapId, playableMaps, resolveMapFloorDefs, resolveMapPlan,
  };
});
