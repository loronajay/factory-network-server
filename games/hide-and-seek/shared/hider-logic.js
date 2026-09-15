(function attachHotelHiders(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelHiders = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelHidersApi() {
  'use strict';

  // A hider's whole job is to be somewhere the seeker is not, and to leave when that stops being
  // true. Three states is enough for that: walking to a spot, sitting crouched in it, and running
  // because something found you.
  //
  // The demon is not the seeker's ally here either — a hider flees both, just at different ranges.
  // The seeker is a person with a torch and a plan, so you move before they are on top of you; the
  // demon is slower to commit, so bolting from it early only makes noise and gives you away.
  //
  // These rules are the offline stand-in for the other players, and they are written to be exactly
  // that: the same threat list, spots and states describe a human hider, so nothing here has to be
  // torn out when real ones arrive — the AI simply stops being asked.

  const HIDER_STATES = Object.freeze({ SETTLING: 'settling', HIDDEN: 'hidden', FLEEING: 'fleeing' });
  const THREATS = Object.freeze({ SEEKER: 'seeker', DEMON: 'demon' });

  const HIDER_DEFAULTS = Object.freeze({
    seekerPanicDistance: 9,
    demonPanicDistance: 7,
    // Seconds after the last sighting before a hider will settle again. Long enough that a seeker
    // sweeping a corridor flushes a hider properly rather than nudging it round a corner.
    calmSeconds: 4,
    // Arriving is not hiding: a hider has to hold still for this long before it counts as hidden.
    settleSeconds: 1.5,
    // How far apart hiders try to keep their spots, so a sweep of one room is not a jackpot.
    spotSpreadDistance: 12,
    // A floor apart is worth this many metres, the same figure the heat meter uses: the stairwell
    // is the only way up, so a floor really is a long way.
    floorPenalty: 26,
    settleSpeed: 2.4,
    fleeSpeed: 4.2,
    // Distances beyond this are all equally safe, so a spot is never picked purely for being far.
    safeDistanceCap: 60,
  });

  function settings(config) {
    return config ? { ...HIDER_DEFAULTS, ...config } : HIDER_DEFAULTS;
  }

  function createHiderState() {
    return { state: HIDER_STATES.SETTLING, spot: null, needsSpot: true, crouching: false, settledFor: 0, calmRemaining: 0 };
  }

  // Distance as a hider experiences it: a threat one floor up is far away even when it is directly
  // overhead, because it has to walk the stairwell to reach you.
  function threatDistance(a, b, config) {
    const cfg = settings(config);
    const floors = Math.abs((a.floor || 1) - (b.floor || 1));
    return Math.hypot(a.x - b.x, a.z - b.z) + floors * cfg.floorPenalty;
  }

  function panicDistance(threat, cfg) {
    return threat.kind === THREATS.DEMON ? cfg.demonPanicDistance : cfg.seekerPanicDistance;
  }

  function spottedBy(self, threats, cfg) {
    for (const threat of threats || []) {
      if (threat && threatDistance(self, threat, cfg) <= panicDistance(threat, cfg)) return threat;
    }
    return null;
  }

  function chooseHideSpot(spots, { threats = [], taken = [], random = Math.random, config } = {}) {
    const cfg = settings(config);
    let best = null;
    let bestScore = -Infinity;
    for (const spot of spots || []) {
      let score = cfg.safeDistanceCap;
      for (const threat of threats) score = Math.min(score, threatDistance(spot, threat, cfg));
      for (const other of taken) {
        if (other === spot || other.id === spot.id) { score -= 1000; continue; }
        if (threatDistance(spot, other, cfg) < cfg.spotSpreadDistance) score -= cfg.spotSpreadDistance;
      }
      // A little jitter so a room's popularity is not decided once and forever by its coordinates.
      score += random() * 3;
      if (score > bestScore) { best = spot; bestScore = score; }
    }
    return best;
  }

  function movementSpeed(state, config) {
    const cfg = settings(config);
    if (!state || state.state === HIDER_STATES.HIDDEN) return 0;
    return state.state === HIDER_STATES.FLEEING ? cfg.fleeSpeed : cfg.settleSpeed;
  }

  // A guest crossing a dark hotel carries a light like everyone else, and puts it out once it is
  // tucked into a room — the whole point of being hidden. It is a real tell rather than flavour: a
  // beam bobbing down a corridor is how a seeker finds someone still looking for a spot, and it is
  // what a spectator watching that guest actually sees by.
  function flashlightOn(state) {
    return !!state && state.state !== HIDER_STATES.HIDDEN;
  }

  function updateHider(previous, { delta = 0, self, threats = [], arrived = false, config } = {}) {
    const cfg = settings(config);
    const state = previous || createHiderState();
    const threat = self ? spottedBy(self, threats, cfg) : null;

    if (threat) {
      // Found. The spot is burned whether or not it was ever any good, so it is dropped rather than
      // returned to once the coast is clear.
      return { ...state, state: HIDER_STATES.FLEEING, spot: null, needsSpot: true, crouching: false, settledFor: 0, calmRemaining: cfg.calmSeconds };
    }

    if (state.state === HIDER_STATES.FLEEING) {
      const calmRemaining = state.calmRemaining - delta;
      if (calmRemaining > 0) return { ...state, calmRemaining };
      return { ...state, state: HIDER_STATES.SETTLING, spot: null, needsSpot: true, crouching: false, settledFor: 0, calmRemaining: 0 };
    }

    if (!arrived) return { ...state, state: HIDER_STATES.SETTLING, crouching: false, settledFor: 0 };
    // Already hidden and nothing has changed: stay put. The settle gate is the way *into* hiding,
    // not a toll paid again every tick.
    if (state.state === HIDER_STATES.HIDDEN) return { ...state, crouching: true };

    const settledFor = state.settledFor + delta;
    if (settledFor < cfg.settleSeconds) return { ...state, state: HIDER_STATES.SETTLING, settledFor };
    return { ...state, state: HIDER_STATES.HIDDEN, crouching: true, settledFor };
  }

  return { HIDER_DEFAULTS, HIDER_STATES, THREATS, chooseHideSpot, createHiderState, flashlightOn, movementSpeed, threatDistance, updateHider };
});
