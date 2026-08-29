(function attachHotelRound(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelRound = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelRoundApi() {
  'use strict';

  // The round is the three-way tension written down. One player is it; everyone else hides; the
  // demon hunts all of them and is nobody's ally. That gives two ways for a round to end and they
  // are deliberately asymmetric: the seeker has to clear the whole hotel, while the hiders win if
  // the demon takes the seeker — which is why seeker-favouring tools have to cost something. Timed
  // rounds remain available as an opt-in rule, but the default hunt has no limit. The demon eliminating a hider still counts toward the seeker's win: the
  // condition is "every hider is out", not "every hider was tagged".
  //
  // Everything here is pure and N-player-shaped so a server can be the authority on it. In
  // particular the catch is resolved from positions rather than announced by a client, because a
  // client that decides it wasn't caught is the obvious cheat.

  const ROLES = Object.freeze({ SEEKER: 'seeker', HIDER: 'hider' });
  const ROUND_STATES = Object.freeze({ LOBBY: 'lobby', ACTIVE: 'active', ENDED: 'ended' });
  // The head start is a real phase, not a cosmetic countdown: the seeker cannot tag during it.
  const PHASES = Object.freeze({ HIDING: 'hiding', SEEKING: 'seeking', ENDED: 'ended' });
  const OUTCOMES = Object.freeze({ SEEKER: 'seeker', HIDERS: 'hiders' });
  const CAUSES = Object.freeze({ ALL_HIDERS_OUT: 'all-hiders-out', SEEKER_LOST: 'seeker-lost', TIMEOUT: 'timeout' });
  const CAUGHT_BY = Object.freeze({ SEEKER: 'seeker', DEMON: 'demon' });

  const ROUND_DEFAULTS = Object.freeze({
    durationSeconds: null,
    // Seconds the hiders get before the seeker is released. The round clock is frozen for it.
    hideSeconds: 45,
    // A tag is a touch, not a look: the seeker has to close the distance the demon is punishing
    // them for crossing.
    tagDistance: 1.8,
    // Two floors are 3.2m apart, so this keeps a tag on one floor without demanding equal feet
    // heights on a stair tread.
    tagHeightTolerance: 1.4,
  });

  function settings(config) {
    if (!config) return ROUND_DEFAULTS;
    return { ...ROUND_DEFAULTS, ...config, hideSeconds: Math.max(ROUND_DEFAULTS.hideSeconds, config.hideSeconds || 0) };
  }

  function pickSeeker(players, seekerId, random) {
    if (seekerId && players.includes(seekerId)) return seekerId;
    if (!players.length) return null;
    const pick = typeof random === 'function' ? random() : Math.random();
    return players[Math.min(players.length - 1, Math.floor(pick * players.length))];
  }

  function createRound({ players = [], seekerId = null, random = Math.random, config } = {}) {
    const cfg = settings(config);
    const roster = [...new Set(players.filter(Boolean))];
    const chosen = pickSeeker(roster, seekerId, random);
    const participants = roster.map((id, seat) => ({
      id,
      seat,
      role: id === chosen ? ROLES.SEEKER : ROLES.HIDER,
      alive: true,
      caughtBy: null,
      caughtAt: null,
    }));
    // One player alone is not a round of hide and seek. It stays in the lobby rather than ending
    // instantly, so a lobby filling up never has to un-end a round.
    const playable = !!chosen && participants.some((entry) => entry.role === ROLES.HIDER);
    return {
      status: playable ? ROUND_STATES.ACTIVE : ROUND_STATES.LOBBY,
      phase: playable ? PHASES.HIDING : null,
      participants,
      hideRemaining: cfg.hideSeconds,
      remaining: cfg.durationSeconds,
      elapsed: 0,
      outcome: null,
      cause: null,
    };
  }

  function participant(state, id) {
    return state.participants.find((entry) => entry.id === id) || null;
  }

  function seekerOf(state) {
    return state.participants.find((entry) => entry.role === ROLES.SEEKER) || null;
  }

  function livingHiders(state) {
    return state.participants.filter((entry) => entry.role === ROLES.HIDER && entry.alive);
  }

  function isActive(state) {
    return !!state && state.status === ROUND_STATES.ACTIVE;
  }

  function endRound(state, outcome, cause) {
    return { ...state, status: ROUND_STATES.ENDED, phase: PHASES.ENDED, outcome, cause };
  }

  // The single place a round is allowed to end, so a tag, a demon kill and the clock can never
  // disagree about who won.
  function settle(state) {
    if (!isActive(state)) return state;
    const seeker = seekerOf(state);
    if (seeker && !seeker.alive) return endRound(state, OUTCOMES.HIDERS, CAUSES.SEEKER_LOST);
    if (!livingHiders(state).length) return endRound(state, OUTCOMES.SEEKER, CAUSES.ALL_HIDERS_OUT);
    if (state.phase === PHASES.SEEKING && Number.isFinite(state.remaining) && state.remaining <= 0) {
      return endRound({ ...state, remaining: 0 }, OUTCOMES.HIDERS, CAUSES.TIMEOUT);
    }
    return state;
  }

  function tickRound(state, delta = 0, config) {
    if (!isActive(state) || !(delta > 0)) return state;
    let hideRemaining = state.hideRemaining;
    let remaining = state.remaining;
    let spend = delta;
    if (hideRemaining > 0) {
      const used = Math.min(hideRemaining, spend);
      hideRemaining -= used;
      // A tick long enough to span the release spends only its remainder on the round clock; the
      // head start must not silently eat seconds the seeker is owed.
      spend -= used;
    }
    if (hideRemaining <= 0 && spend > 0 && Number.isFinite(remaining)) remaining = Math.max(0, remaining - spend);
    const phase = hideRemaining > 0 ? PHASES.HIDING : PHASES.SEEKING;
    return settle({ ...state, hideRemaining, remaining, phase, elapsed: state.elapsed + delta });
  }

  // Whether a seeker is actually on top of a hider. Distance, height and sight, in that order — a
  // tag through a wall would make hiding in a closed room pointless.
  function canTag({ seeker, hider, occluded = false } = {}, config) {
    if (!seeker || !hider || occluded) return false;
    const cfg = settings(config);
    if (Math.abs((seeker.y || 0) - (hider.y || 0)) > cfg.tagHeightTolerance) return false;
    return Math.hypot(seeker.x - hider.x, seeker.z - hider.z) <= cfg.tagDistance;
  }

  function eliminate(state, id, caughtBy) {
    const target = participant(state, id);
    if (!target || !target.alive) return state;
    const participants = state.participants.map((entry) => (
      entry.id === id ? { ...entry, alive: false, caughtBy, caughtAt: state.elapsed } : entry
    ));
    return settle({ ...state, participants });
  }

  function resolveTag(state, { seekerId, hiderId } = {}) {
    if (!isActive(state) || state.phase !== PHASES.SEEKING) return state;
    const seeker = seekerOf(state);
    if (!seeker || !seeker.alive || seeker.id !== seekerId) return state;
    const target = participant(state, hiderId);
    if (!target || target.role !== ROLES.HIDER) return state;
    return eliminate(state, hiderId, CAUGHT_BY.SEEKER);
  }

  // The demon does not care about roles. Taking a hider helps the seeker; taking the seeker ends it.
  function resolveDemonCatch(state, playerId) {
    if (!isActive(state)) return state;
    return eliminate(state, playerId, CAUGHT_BY.DEMON);
  }

  function formatClock(seconds) {
    if (!Number.isFinite(seconds)) return 'NO LIMIT';
    const whole = Math.max(0, Math.ceil(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  }

  // What a HUD is allowed to know. Deliberately position-free: the removed tracker minimap is the
  // standing reminder that showing where anyone is defeats the game and, online, leaks hiders.
  function describeRound(state, config) {
    const hiders = state.participants.filter((entry) => entry.role === ROLES.HIDER);
    const seconds = state.phase === PHASES.HIDING ? state.hideRemaining : state.remaining;
    return {
      phase: state.phase,
      over: state.status === ROUND_STATES.ENDED,
      outcome: state.outcome,
      cause: state.cause,
      seconds,
      clock: formatClock(seconds),
      hidersRemaining: hiders.filter((entry) => entry.alive).length,
      hidersTotal: hiders.length,
      caught: hiders.filter((entry) => !entry.alive).map((entry) => ({ id: entry.id, by: entry.caughtBy })),
    };
  }

  return {
    ROLES, ROUND_STATES, PHASES, OUTCOMES, CAUSES, CAUGHT_BY, ROUND_DEFAULTS,
    canTag, createRound, describeRound, formatClock, livingHiders, participant, resolveDemonCatch, resolveTag, seekerOf, tickRound,
  };
});
