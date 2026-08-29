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

  function createFlashlightDrop(state) {
    return { charge: normalizeCharge(state?.charge) };
  }

  return {
    addFlashlightCharge, createFlashlightDrop, createFlashlightState, describeFlashlight,
    setFlashlight, tickFlashlight, toggleFlashlight,
  };
});
