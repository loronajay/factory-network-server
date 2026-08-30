(function attachHotelFlashlight(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelFlashlight = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelFlashlightApi() {
  'use strict';

  function normalizeCharge(value) {
    return Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 1000000) / 1000000;
  }

  function createFlashlightState(on = false, charge = 1) {
    const available = normalizeCharge(charge);
    return { on: !!on && available > 0, charge: available };
  }

  function setFlashlight(state, on) {
    return { ...state, on: !!on && state.charge > 0 };
  }

  function toggleFlashlight(state) {
    return setFlashlight(state, !state.on);
  }

  function describeFlashlight(state) {
    return { on: !!state?.on, charge: normalizeCharge(state?.charge) };
  }

  function tickFlashlight(state, delta, { drainSeconds = 300 } = {}) {
    if (!state.on || !(delta > 0) || !(drainSeconds > 0)) return state;
    const charge = normalizeCharge(state.charge - delta / drainSeconds);
    return { ...state, on: charge > 0, charge };
  }

  function addFlashlightCharge(state, amount) {
    return { ...state, charge: normalizeCharge(state.charge + Math.max(0, Number(amount) || 0)) };
  }

  // A press is the player's, the battery is the server's.
  //
  // Online the local light used to be overwritten with `self.flashlight` out of every snapshot, and a
  // snapshot is a round trip old: pressing F flipped the light on, the next frame mirrored the stale
  // "off" back over it, and the input that finally went out said off again. The toggle only survived
  // when the timing happened to line up, which is exactly what a player reports as "F only works
  // sometimes". So an online toggle records an *intent* that outlives the round trip. It is held
  // until the authority agrees with it, until the authority refuses it (an empty battery cannot be
  // switched on), or until the grace runs out — never longer, because a client that ignores the
  // server forever is the same class of bug one level up.
  const INTENT_GRACE_MS = 1500;

  function createFlashlightIntent(on, now = 0, graceMs = INTENT_GRACE_MS) {
    return { on: !!on, until: (Number(now) || 0) + graceMs };
  }

  // Returns the state to display and the intent still outstanding (`null` once it has settled). The
  // charge is always the authority's; only `on` is ever held locally.
  function reconcileFlashlight(remote, intent = null, now = 0) {
    const authoritative = describeFlashlight(remote);
    if (!intent) return { state: createFlashlightState(authoritative.on, authoritative.charge), intent: null };
    const settled = authoritative.on === intent.on
      || authoritative.charge <= 0
      || (Number(now) || 0) >= intent.until;
    if (settled) return { state: createFlashlightState(authoritative.on, authoritative.charge), intent: null };
    return { state: createFlashlightState(intent.on, authoritative.charge), intent };
  }

  function createFlashlightDrop(state) {
    return { charge: normalizeCharge(state?.charge) };
  }

  // Plans own possible locations; only the round owner samples them. Online this runs once on
  // the server's seeded RNG, never on a rendering client or in the tick. Sampling per floor keeps
  // a lucky roll from putting all the resupplies on one level. Records never alias the cached plan.
  function createFloorPickups(points = [], random = Math.random) {
    const floors = new Map();
    for (const point of points) {
      if (!floors.has(point.floor)) floors.set(point.floor, []);
      floors.get(point.floor).push(point);
    }
    const pickups = [];
    for (const candidates of floors.values()) {
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
      for (const point of candidates.slice(0, Math.ceil(candidates.length / 2))) {
        pickups.push({ id: `floor-flashlight-${point.id}`, x: point.x, y: point.y, z: point.z,
          floor: point.floor, charge: normalizeCharge(0.35 + random() * 0.3) });
      }
    }
    return pickups;
  }

  return {
    INTENT_GRACE_MS,
    addFlashlightCharge, createFlashlightDrop, createFlashlightIntent, createFlashlightState, createFloorPickups,
    describeFlashlight, reconcileFlashlight, setFlashlight, tickFlashlight, toggleFlashlight,
  };
});
