(function attachHotelStamina(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelStamina = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelStaminaApi() {
  'use strict';

  // Sprinting is the seeker-favouring tool the design says has to cost something, so it is metered.
  // The bar drains only while you are actually running, and it refills whenever you are not: fastest
  // crouched in cover, slower standing, slowest still walking the halls. Emptying it locks sprinting
  // out entirely until you have earned a real share of it back — the panic run has to end somewhere.
  const STAMINA_DEFAULTS = Object.freeze({
    // Seconds of continuous sprinting a full bar buys.
    sprintSeconds: 6,
    // Seconds an empty bar takes to refill, by what you are doing while it refills.
    walkRecoverSeconds: 14,
    restRecoverSeconds: 7,
    crouchRecoverSeconds: 5,
    // How much of the bar an exhausted player has to win back before sprinting unlocks again. Without
    // it, emptying the bar would give a stutter-sprint one frame later instead of a real cost.
    recoverThreshold: 0.35,
  });

  const RECOVERY = Object.freeze({ CROUCH: 'crouch', REST: 'rest', WALK: 'walk' });

  function settings(config) {
    return config ? { ...STAMINA_DEFAULTS, ...config } : STAMINA_DEFAULTS;
  }

  function createStaminaState() {
    return { value: 1, sprinting: false, exhausted: false, recovery: RECOVERY.REST };
  }

  // Whether the bar will honour a sprint request right now. Exhaustion, not emptiness, is the gate:
  // a bar at 10% still sprints, a bar recovering from zero does not.
  function canSprint(state) {
    return !!state && !state.exhausted && state.value > 0;
  }

  function recoveryKind(moving, crouching) {
    if (crouching) return RECOVERY.CROUCH;
    return moving ? RECOVERY.WALK : RECOVERY.REST;
  }

  function recoverySeconds(cfg, kind) {
    if (kind === RECOVERY.CROUCH) return cfg.crouchRecoverSeconds;
    return kind === RECOVERY.WALK ? cfg.walkRecoverSeconds : cfg.restRecoverSeconds;
  }

  function updateStamina(previous, { delta = 0, wantSprint = false, moving = false, crouching = false, config } = {}) {
    const cfg = settings(config);
    const state = previous || createStaminaState();
    // A crouched player is catching their breath, not running, so the key is simply ignored there.
    const sprinting = !!wantSprint && !!moving && !crouching && canSprint(state);
    if (sprinting) {
      const drainPerSecond = cfg.sprintSeconds > 0 ? 1 / cfg.sprintSeconds : Infinity;
      const value = Math.max(0, state.value - delta * drainPerSecond);
      return { value, sprinting: value > 0, exhausted: value <= 0, recovery: null };
    }
    const kind = recoveryKind(moving, crouching);
    const seconds = recoverySeconds(cfg, kind);
    const value = Math.min(1, state.value + (seconds > 0 ? delta / seconds : 1));
    return { value, sprinting: false, exhausted: state.exhausted && value < cfg.recoverThreshold, recovery: kind };
  }

  return { RECOVERY, STAMINA_DEFAULTS, canSprint, createStaminaState, updateStamina };
});
