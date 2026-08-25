// One Speed Demon room, as a pure engine.
//
// Owns the lobby, the tree, and — the part that matters — **adjudication**. It
// never touches a socket: every method returns the messages the bridge should
// send, which is what lets the whole match lifecycle be unit tested without a
// network. Same split as circuit-siege's room engine.
//
// ## Why the server replays
//
// A drag race is two cars in two lanes that never touch. Each client therefore
// simulates its own car at full local responsiveness — a lockstep input delay
// would tax the exact millisecond shift timing the game is built on, and buy
// nothing, because there is no interaction to keep consistent. What the clients
// exchange is *inputs*, and each draws the other's car by running the same pure
// sim on them.
//
// That leaves one job that cannot be left to a client: deciding who won. A
// client that reports its own finishing time is not being adjudicated, it is
// being believed. So the server keeps every driver's input log and replays it
// through its own copy of the physics. A client can claim inputs; the server
// decides what those inputs achieved.
//
// ## Why a red light ends the round at green
//
// On a strip the red bulb lights before the cars have left. Fouls are collected
// across the whole countdown and resolved the instant it goes green: the race
// does not run, and the round either re-runs or is forfeit. Collecting rather
// than resolving-on-first is what keeps the double-red rule meaningful — both
// drivers can jump the same tree, and the rule for that case needs to see both.

import { RACE_DISTANCES, TICK_HZ } from "../shared/constants.mjs";
import { GATE_6_SPEED, createGate } from "../shared/gate.mjs";
import { DEFAULT_CAR } from "../shared/constants.mjs";
import { replayRun, mergeEvents, createInputLog } from "../shared/input-log.mjs";
import {
  BEST_OF_OPTIONS,
  DEFAULT_BEST_OF,
  EVENT_MATCH_WON,
  EVENT_ROUND_RESTART,
  EVENT_ROUND_WON,
  createMatch,
  isDecided,
  matchScore,
  recordDisconnect,
  recordFalseStarts,
  recordFinish,
} from "../shared/match.mjs";
import {
  circuitLoadoutAvailable,
  createAuthoritativeCircuitRound,
  ticksForElapsedMs,
} from "./speed-demon-circuit-engine.mjs";
import { CIRCUIT_TRACK_IDS, DEFAULT_CIRCUIT_TRACK_ID } from "../shared/circuit-tracks.mjs";

export const PHASE_LOBBY = "lobby";
export const PHASE_COUNTDOWN = "countdown";
export const PHASE_RUNNING = "running";
export const PHASE_ROUND_OVER = "round-over";
export const PHASE_MATCH_OVER = "match-over";

/** The drag strips a room may pick; circuit geometry has its own catalog. */
export const TRACK_IDS = ["track-a", "track-b", "track-c", "track-d", "track-e"];
/** Casual opens every distance; ranked will restrict this to quarter and half. */
export const DISTANCE_IDS = ["eighth", "quarter", "half", "mile"];

export const DEFAULT_CONFIG = {
  raceTypeId: "drag",
  trackId: "track-a",
  distanceId: "quarter",
  laps: 3,
  bestOf: DEFAULT_BEST_OF,
};

/**
 * How long the tree runs, and how long clients are given to receive the start
 * message before it does. `startAt` is `serverNow + LEAD_MS`, which is the
 * primitive `match_ready` already established for a synchronized countdown —
 * reaction times are only comparable between two machines if both trees went
 * green at the same instant.
 */
export const COUNTDOWN_SECONDS = 3;
export const START_LEAD_MS = 1200;

/**
 * A driver gets this long past the leader's finish before their round is called
 * in. Without it a disconnect mid-round would hang the match forever.
 */
export const ROUND_TIMEOUT_MS = 90000;

/**
 * How far ahead of real time a client's inputs may claim to be.
 *
 * This is the one cheap check that stops a fabricated log. A client can always
 * *invent* inputs, but it cannot invent them faster than the race is actually
 * being run: an event for tick 600 that arrives one wall-clock second after the
 * green did not happen. Late is fine and expected — that is just the network —
 * so the bound is one-sided.
 */
export const INPUT_LEAD_TICKS = 90; // 1.5s of slack for jitter and batching

export function createSpeedDemonMatchEngine({ now = () => Date.now(), config = {} } = {}) {
  const state = {
    phase: PHASE_LOBBY,
    config: normalizeConfig(config),
    players: [], // { clientId, playerId, displayName, modelId, livery, lane, ready }
    hostClientId: null,
    match: null,
    round: null, // { number, attempt, startAt, logs, results }
    rematch: new Set(),
  };

  // -------------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------------

  function assignPlayer({ clientId, playerId, displayName, modelId, livery }) {
    if (state.players.some((player) => player.clientId === clientId)) {
      return { ok: true, player: playerFor(clientId) };
    }
    if (state.players.length >= 2) {
      return { ok: false, code: "ROOM_FULL", message: "This room already has two cars in it" };
    }
    const player = {
      clientId,
      // **Never the client's word alone.** Two sockets can genuinely arrive
      // claiming the same id — signed-out drivers share a default profile, and
      // two tabs of the same browser share localStorage — and a match between
      // two identical ids is not a match. `createMatch` rejects it, and because
      // the router calls the bridge inside a `ws` handler with no guard, that
      // throw used to take the entire server process down with it: every room,
      // not just this one. The id is made unique within the room instead of
      // trusted, so a collision costs a suffix rather than everybody's match.
      playerId: uniquePlayerId(playerId, clientId),
      // What they actually claim to be, kept separately: it is what a public
      // loadout lookup keys on, and it is presentation rather than identity.
      accountId: typeof playerId === "string" ? playerId : "",
      displayName: sanitizeName(displayName),
      modelId: typeof modelId === "string" ? modelId : null,
      livery: livery ?? null,
      // Lanes 1 and 2 straddle the divider and are the drag-race pair. First in
      // takes the left one; nothing about the race reads this.
      lane: state.players.length === 0 ? 1 : 2,
      ready: false,
    };
    state.players.push(player);
    if (state.hostClientId === null) {
      state.hostClientId = clientId;
    }
    return { ok: true, player };
  }

  /**
   * The car a player is driving. Sent on to the opponent so their client can
   * draw the real thing rather than a default — the public loadout endpoints
   * exist for exactly this, and this is the path that finally consumes them.
   */
  function setLoadout(clientId, { modelId, livery }) {
    const player = playerFor(clientId);
    if (!player) return null;
    player.modelId = typeof modelId === "string" ? modelId : player.modelId;
    player.livery = livery ?? player.livery;
    return player;
  }

  /**
   * Only the host may change the config, and only in the lobby. Quick-search
   * rooms are built with a server-chosen config and have no host edits at all —
   * the bridge simply never routes one.
   */
  function setConfig(clientId, next) {
    if (state.phase !== PHASE_LOBBY) {
      return { ok: false, code: "MATCH_STARTED", message: "The config is locked once the match starts" };
    }
    if (clientId !== state.hostClientId) {
      return { ok: false, code: "NOT_HOST", message: "Only the host can change the race" };
    }
    state.config = normalizeConfig({ ...state.config, ...next });
    return { ok: true, config: state.config };
  }

  function setReady(clientId, ready = true) {
    const player = playerFor(clientId);
    if (!player) return false;
    player.ready = !!ready;
    return true;
  }

  function circuitStartIssue() {
    if (state.config.raceTypeId !== "circuit") return null;
    const unavailable = state.players.find((player) => !circuitLoadoutAvailable(player));
    return unavailable
      ? { code: "CIRCUIT_ATLAS_UNAVAILABLE", message: `${unavailable.displayName} needs a Circuit Race car` }
      : null;
  }

  function everyoneReady() {
    return state.players.length === 2 && state.players.every((player) => player.ready);
  }

  // -------------------------------------------------------------------------
  // Rounds
  // -------------------------------------------------------------------------

  /**
   * Starts the match, or the next round of one. Returns the payload both clients
   * need to run the same tree at the same instant.
   */
  function startRound() {
    if (state.players.length !== 2) return null;
    if (circuitStartIssue()) return null;
    if (!state.match) {
      state.match = createMatch({
        playerIds: state.players.map((player) => player.playerId),
        bestOf: state.config.bestOf,
      });
    }
    if (isDecided(state.match)) return null;

    const serverNow = now();
    state.phase = PHASE_COUNTDOWN;
    state.round = {
      number: state.match.round.number,
      attempt: state.match.round.attempt,
      startAt: serverNow + START_LEAD_MS,
      logs: new Map(state.players.map((player) => [player.playerId, createInputLog()])),
      results: new Map(),
      circuit: state.config.raceTypeId === "circuit"
        ? createAuthoritativeCircuitRound({
          players: state.players,
          laps: state.config.laps,
          trackId: state.config.trackId,
        })
        : null,
    };
    for (const player of state.players) player.ready = false;

    return {
      round: state.round.number,
      attempt: state.round.attempt,
      serverNow,
      startAt: state.round.startAt,
      countdownSeconds: COUNTDOWN_SECONDS,
      distanceMetres: state.config.raceTypeId === "drag" ? RACE_DISTANCES[state.config.distanceId].metres : null,
      raceTypeId: state.config.raceTypeId,
      participants: state.players.map(({ playerId, modelId, livery }) => ({ playerId, modelId, livery })),
      config: state.config,
      score: matchScore(state.match),
    };
  }

  /** The tree has gone green. Only after this do inputs count as timely. */
  function markRunning() {
    if (state.phase === PHASE_COUNTDOWN) state.phase = PHASE_RUNNING;
  }

  /**
   * Folds a driver's streamed inputs into the log the server will adjudicate on.
   *
   * The lead check is the anti-fabrication guard: inputs may arrive late, but an
   * event claiming a tick the race has not reached yet cannot have been made.
   * Rejected events are dropped rather than the client being disconnected — a
   * clock skew should cost a packet, not a match.
   */
  function recordInputs(clientId, { round, attempt, events }) {
    const player = playerFor(clientId);
    if (!player || !state.round) return null;
    if (round !== state.round.number || attempt !== state.round.attempt) return null;
    if (state.phase !== PHASE_COUNTDOWN && state.phase !== PHASE_RUNNING) return null;

    const elapsedTicks = Math.max(0, ((now() - state.round.startAt) / 1000) * TICK_HZ);
    const ceiling = elapsedTicks + INPUT_LEAD_TICKS;
    const timely = (events ?? []).filter((event) => Number(event?.t) <= ceiling);

    const merged = mergeEvents(state.round.logs.get(player.playerId), timely);
    state.round.logs.set(player.playerId, merged);
    return { player, accepted: timely, rejected: (events ?? []).length - timely.length };
  }

  function recordCircuitInputs(clientId, { round, attempt, events }) {
    const player = playerFor(clientId);
    if (!player || !state.round?.circuit) return null;
    if (round !== state.round.number || attempt !== state.round.attempt) return null;
    if (state.phase !== PHASE_COUNTDOWN && state.phase !== PHASE_RUNNING) return null;
    return { player, ...state.round.circuit.receive(player.playerId, events) };
  }

  function advanceCircuit() {
    if (!state.round?.circuit || state.phase === PHASE_MATCH_OVER) return null;
    const elapsedMs = now() - state.round.startAt;
    if (elapsedMs < 0) return null;
    markRunning();
    const snapshot = state.round.circuit.advance(ticksForElapsedMs(elapsedMs));
    return { snapshot, result: state.round.circuit.finished ? adjudicateCircuit() : null };
  }

  function adjudicateCircuit() {
    if (!state.round?.circuit || !state.match || state.phase === PHASE_MATCH_OVER) return null;
    const results = state.round.circuit.results;
    state.match = recordFinish(state.match, results);
    state.phase = PHASE_MATCH_OVER;
    const winner = results.find((entry) => entry.playerId === state.match.winnerId);
    return {
      round: state.round.number,
      attempt: state.round.attempt,
      outcome: state.match.lastEvent,
      redLight: false,
      offenders: [],
      runs: results.map((run) => ({ ...run, finishTime: run.finishTime })),
      score: matchScore(state.match),
      decided: true,
      winnerId: state.match.winnerId ?? winner?.playerId ?? null,
      loserId: state.match.loserId,
      history: state.match.history,
    };
  }

  /**
   * A driver reporting their run is over. What they *claim* about it is ignored:
   * the flag only says "I have sent you everything", and the round is decided by
   * replaying the log the server holds.
   */
  function recordDone(clientId, { round, attempt }) {
    const player = playerFor(clientId);
    if (!player || !state.round) return false;
    if (round !== state.round.number || attempt !== state.round.attempt) return false;
    state.round.results.set(player.playerId, true);
    return state.round.results.size === 2;
  }

  /** True once every driver has reported in, or the round has run out of time. */
  function roundIsOver() {
    if (!state.round || state.phase === PHASE_LOBBY) return false;
    if (state.round.circuit) return state.round.circuit.finished;
    if (state.round.results.size === 2) return true;
    return now() - state.round.startAt > ROUND_TIMEOUT_MS;
  }

  /**
   * Replays both logs and decides the round.
   *
   * The order here is the rule: the tree is adjudicated **first**, because a red
   * light means the race never ran. Only a clean tree gets its finishing times
   * compared.
   */
  function adjudicate() {
    if (!state.round || !state.match) return null;
    // **Once per round, ever.** A client reports `done` when its run ends, and a
    // client that keeps saying so — a loop that re-sends every tick, or one
    // doing it on purpose — would otherwise decide the round again on each
    // message, awarding a win every time and finishing a best-of-three off a
    // single race. The round is live only between the tree and this call.
    if (state.phase !== PHASE_COUNTDOWN && state.phase !== PHASE_RUNNING) return null;

    const options = raceOptions();
    const runs = state.players.map((player) => {
      const log = state.round.logs.get(player.playerId) ?? createInputLog();
      const { race, complete } = replayRun(options, log, { maxTicks: replayCeiling() });
      return { player, race, complete };
    });

    const offenders = runs
      .filter((run) => run.race.falseStart)
      .map((run) => ({
        playerId: run.player.playerId,
        jumpedBeforeGreen: run.race.falseStartAt ?? 0,
      }));

    state.match = offenders.length > 0
      ? recordFalseStarts(state.match, offenders)
      : recordFinish(
          state.match,
          runs.map((run) => ({
            playerId: run.player.playerId,
            finishTime: run.race.finishTime,
            complete: run.complete,
          })),
        );

    const decided = isDecided(state.match);
    state.phase = decided ? PHASE_MATCH_OVER : PHASE_ROUND_OVER;

    return {
      round: state.round.number,
      attempt: state.round.attempt,
      // Deliberately not called `event`: these results are spread into a wire
      // message whose own envelope key is `event`, and the collision silently
      // replaced the message name with this object.
      outcome: state.match.lastEvent,
      redLight: offenders.length > 0,
      offenders,
      // Per-driver detail for the results panel. These are the server's numbers,
      // replayed here — not anything a client said about itself.
      runs: runs.map((run) => ({
        playerId: run.player.playerId,
        displayName: run.player.displayName,
        finishTime: run.race.finishTime,
        complete: run.complete,
        falseStart: run.race.falseStart,
        reactionTime: run.race.reactionTime,
        launchGrade: run.race.launchGrade,
        topSpeed: run.race.topSpeed,
        distance: run.race.vehicle.distance,
        shifts: run.race.shifts.map((shift) => ({
          grade: shift.grade,
          catchGrade: shift.catch?.grade ?? null,
        })),
      })),
      score: matchScore(state.match),
      decided,
      winnerId: state.match.winnerId,
      loserId: state.match.loserId,
      history: state.match.history,
    };
  }

  /**
   * What happens after a round is decided: another attempt at the same round, the
   * next round, or the end of the match. The names come straight from the match
   * reducer so there is one vocabulary rather than two.
   */
  function nextStep() {
    if (!state.match) return "none";
    if (isDecided(state.match)) return "match-over";
    return state.match.lastEvent.kind === EVENT_ROUND_RESTART ? "same-round" : "next-round";
  }

  // -------------------------------------------------------------------------
  // Leaving, and coming back for more
  // -------------------------------------------------------------------------

  function removePlayer(clientId) {
    const player = playerFor(clientId);
    if (!player) return null;
    state.players = state.players.filter((entry) => entry.clientId !== clientId);
    state.rematch.delete(clientId);

    // A match in progress is conceded; one that had not started simply empties.
    if (state.match && !isDecided(state.match)) {
      state.match = recordDisconnect(state.match, player.playerId);
      state.phase = PHASE_MATCH_OVER;
      return { player, conceded: true, winnerId: state.match.winnerId };
    }
    if (state.hostClientId === clientId) {
      state.hostClientId = state.players[0]?.clientId ?? null;
    }
    return { player, conceded: false, winnerId: null };
  }

  /**
   * The rematch handshake: both drivers have to ask. Rebuilding the match rather
   * than resetting it in place keeps every "a new match starts here" rule in one
   * function — the alternative quietly carried a stale round or fault counter
   * into the next one.
   */
  function requestRematch(clientId) {
    if (state.phase !== PHASE_MATCH_OVER) return { ok: false, started: false };
    if (!playerFor(clientId)) return { ok: false, started: false };
    state.rematch.add(clientId);

    const started = state.players.length === 2
      && state.players.every((player) => state.rematch.has(player.clientId));
    if (started) {
      state.rematch.clear();
      state.match = null;
      state.round = null;
      state.phase = PHASE_LOBBY;
      for (const player of state.players) player.ready = false;
    }
    return {
      ok: true,
      started,
      requested: state.players.map((player) => ({
        playerId: player.playerId,
        requested: state.rematch.has(player.clientId),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function playerFor(clientId) {
    return state.players.find((player) => player.clientId === clientId) ?? null;
  }

  /**
   * An id that is unique inside this room.
   *
   * A blank id, or one already taken by the driver in the other lane, is
   * suffixed with the socket's own id — which the server issues and so knows to
   * be unique. A genuine pair of distinct accounts keeps their real ids, which
   * is what lets the public loadout endpoints resolve the opponent's car.
   */
  function uniquePlayerId(playerId, clientId) {
    const claimed = typeof playerId === "string" ? playerId.trim() : "";
    const taken = state.players.some((player) => player.playerId === claimed);
    return claimed && !taken ? claimed : `${claimed || "guest"}#${clientId}`;
  }

  function raceOptions() {
    return {
      car: DEFAULT_CAR,
      gate: createGate(GATE_6_SPEED),
      distanceMetres: RACE_DISTANCES[state.config.distanceId].metres,
      countdownSeconds: COUNTDOWN_SECONDS,
    };
  }

  /**
   * A replay ceiling proportional to the distance being run, rather than the
   * ten-minute global one. A hostile log should not be able to buy the server
   * more work than the round it belongs to could possibly need.
   */
  function replayCeiling() {
    const metres = RACE_DISTANCES[state.config.distanceId].metres;
    return Math.ceil((metres / 10) * TICK_HZ) + 600; // ~10 m/s floor, plus the tree
  }

  function describe() {
    return {
      phase: state.phase,
      config: { ...state.config },
      hostClientId: state.hostClientId,
      players: state.players.map((player) => ({
        clientId: player.clientId,
        playerId: player.playerId,
        displayName: player.displayName,
        modelId: player.modelId,
        livery: player.livery,
        lane: player.lane,
        ready: player.ready,
      })),
      round: state.round ? { number: state.round.number, attempt: state.round.attempt } : null,
      score: state.match ? matchScore(state.match) : null,
    };
  }

  return {
    assignPlayer,
    setLoadout,
    setConfig,
    setReady,
    everyoneReady,
    startRound,
    markRunning,
    recordInputs,
    recordCircuitInputs,
    advanceCircuit,
    circuitStartIssue,
    recordDone,
    roundIsOver,
    adjudicate,
    nextStep,
    removePlayer,
    requestRematch,
    describe,
    playerFor,
    get phase() {
      return state.phase;
    },
    get players() {
      return state.players;
    },
    get config() {
      return state.config;
    },
    get match() {
      return state.match;
    },
    get hostClientId() {
      return state.hostClientId;
    },
  };
}

/**
 * Every field is clamped to something the catalog knows about rather than
 * rejected. A config arriving with a track this build has never heard of should
 * put two cars on a real strip, not fail a room into existence.
 */
export function normalizeConfig(config = {}) {
  const raceTypeId = config.raceTypeId === "circuit" ? "circuit" : "drag";
  const trackId = raceTypeId === "circuit"
    ? CIRCUIT_TRACK_IDS.includes(config.trackId) ? config.trackId : DEFAULT_CIRCUIT_TRACK_ID
    : TRACK_IDS.includes(config.trackId) ? config.trackId : DEFAULT_CONFIG.trackId;
  const distanceId = DISTANCE_IDS.includes(config.distanceId)
    ? config.distanceId
    : DEFAULT_CONFIG.distanceId;
  const bestOf = raceTypeId === "circuit" ? 1
    : BEST_OF_OPTIONS.includes(config.bestOf) ? config.bestOf : DEFAULT_CONFIG.bestOf;
  const laps = [1, 3, 5].includes(config.laps) ? config.laps : DEFAULT_CONFIG.laps;
  return { raceTypeId, trackId, distanceId, laps, bestOf };
}

/**
 * The config a quick-search match runs, chosen from the match seed.
 *
 * Deriving it from the seed rather than from either client is what stops a
 * search match being configured by whoever happened to queue first, and it means
 * both clients compute the same race without a negotiation round trip.
 */
export function configFromSeed(seed) {
  const value = Math.abs(Math.trunc(Number(seed) || 0));
  return normalizeConfig({
    trackId: TRACK_IDS[value % TRACK_IDS.length],
    // Quick search sticks to the two competitive lengths; a private room opens
    // all four. An eighth-mile stranger match is over before it starts, and a
    // full mile is a long time to spend with someone who may just walk away.
    distanceId: Math.floor(value / TRACK_IDS.length) % 2 === 0 ? "quarter" : "half",
    bestOf: DEFAULT_BEST_OF,
  });
}

function sanitizeName(name) {
  const trimmed = typeof name === "string" ? name.trim().slice(0, 24) : "";
  return trimmed || "Driver";
}

export { EVENT_MATCH_WON, EVENT_ROUND_WON, EVENT_ROUND_RESTART };
