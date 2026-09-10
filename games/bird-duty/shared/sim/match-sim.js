// Bird Duty: the whole online match as one pure function.
//
// This module exists so that nobody playing the game decides anything about it. It used to be a
// branch inside `game.js`'s tick, which meant the authority was whichever browser happened to have
// created the lobby — that player adjudicated their own hits, their own score and their own win, and
// when they closed the tab the match died with them. Both are the wrong shape for a competitive
// game.
//
// Everything here is deterministic and clock-free: give it the same starting players and the same
// per-tick inputs and it produces the same match, byte for byte. That is what lets
// `factory-network-server` run it as the authority while every client runs nothing at all — the
// server holds the state, the clients send three booleans and draw what comes back.
//
// The one rule this file must keep: a client's message can only ever be an *intent*. There is no
// entry point here that accepts a score, a hit, a position or a result.
import { createInputState } from "./input.js";
import { createPlayerState, updatePlayer } from "./player.js";
import { createPoopState, spawnPoopFromPlayer, updatePoop } from "./poop.js";
import { createNpcState, processNpcHits, updateNpcState } from "./npcs.js";
import { addScore, canFireShot, createPlaySession, fireShot, updatePlaySession } from "./play-session.js";
import { HOTSEAT_SHOTS_PER_TURN } from "./hotseat-session.js";
import {
  ONLINE_MATCH_PHASE,
  addOnlineMatchScore,
  createOnlineMatchSession,
  finishOnlineMatchTurn,
  getOnlineActivePlayer,
  startOnlineMatchTurn,
} from "./online-match.js";
import { createOnlineSoundQueue, queueOnlineNpcHitSounds, queueOnlineSound } from "./online-sync.js";

// The cabinet's rate, and the only rate any of this is tuned for. Published in every snapshot so a
// client can advance presentation between them instead of stepping at the snapshot rate.
export const BIRD_DUTY_TICK_RATE = 60;
export const BIRD_DUTY_PROTOCOL_VERSION = 1;
export const MATCH_SIM_PHASE = ONLINE_MATCH_PHASE;

// How long the result board stays up before the match is considered finished with.
export const MATCH_OVER_LINGER_TICKS = 240;

/**
 * The only shape a client is allowed to send.
 *
 * Anything else on the message — a score, a position, a claim about a hit — dies here rather than
 * reaching the state. `drop` is a *held* flag, not a request: the edge is detected inside the tick,
 * so a client cannot empty its magazine by repeating a press it never released.
 */
export function readMatchSimInput(value) {
  const held = (flag) => flag === true || flag === 1;
  return {
    left: held(value?.left),
    right: held(value?.right),
    drop: held(value?.drop),
  };
}

export const NO_MATCH_SIM_INPUT = Object.freeze(readMatchSimInput(null));

function createTurnWorld(round) {
  return {
    player: createPlayerState(),
    poop: createPoopState(),
    playSession: createPlaySession({ shotsPerRun: HOTSEAT_SHOTS_PER_TURN }),
    npcs: createNpcState({ round }),
  };
}

export function createMatchSimState(options = {}) {
  const match = createOnlineMatchSession(options.players || []);
  return {
    protocolVersion: BIRD_DUTY_PROTOCOL_VERSION,
    tickRate: BIRD_DUTY_TICK_RATE,
    tick: 0,
    match,
    world: createTurnWorld(match.round),
    // The latest input from each seat. Never a queue: a client that goes quiet should keep walking
    // the way it was already walking, not bank moves and spend them in a burst when it comes back.
    inputs: {},
    // Which seats currently hold the drop key, so the tick can find the press edge itself.
    dropHeld: {},
    sounds: createOnlineSoundQueue(),
    matchOverTicks: 0,
  };
}

export function matchSimActivePlayerId(state) {
  return getOnlineActivePlayer(state?.match)?.clientId || null;
}

export function matchSimHasPlayer(state, clientId) {
  return Boolean(state?.match?.players?.some((player) => player.clientId === clientId));
}

/** Record a client's intent. Refused outright for anyone not holding a seat in this match. */
export function applyMatchSimInput(state, clientId, value) {
  if (!matchSimHasPlayer(state, clientId)) return state;
  return {
    ...state,
    inputs: { ...state.inputs, [clientId]: readMatchSimInput(value) },
  };
}

/** A seat that has gone away stops driving; its bird stands still rather than holding a stride. */
export function clearMatchSimInput(state, clientId) {
  if (!state?.inputs?.[clientId]) return state;
  return {
    ...state,
    inputs: { ...state.inputs, [clientId]: { ...NO_MATCH_SIM_INPUT } },
    dropHeld: { ...state.dropHeld, [clientId]: false },
  };
}

/**
 * Turn a seat's held flags into the input shape the cabinet's pure movement code expects, finding
 * the drop *edge* here rather than trusting a client to send one.
 */
function inputStateFor(state, clientId) {
  const held = state.inputs[clientId] || NO_MATCH_SIM_INPUT;
  const wasHeld = state.dropHeld[clientId] === true;
  return {
    ...createInputState(),
    left: held.left,
    right: held.right,
    dropHeld: held.drop,
    dropRequested: held.drop && !wasHeld,
  };
}

function rememberDropHeld(state, inputs) {
  const dropHeld = {};
  for (const player of state.match.players) {
    dropHeld[player.clientId] = (inputs[player.clientId] || NO_MATCH_SIM_INPUT).drop === true;
  }
  return dropHeld;
}

/**
 * Advance the match one 60hz tick.
 *
 * `inputsById` is optional; when omitted the state's own buffered inputs are used, which is what the
 * server does — a tick fires on a timer, not on a message.
 */
export function tickMatchSim(state, inputsById) {
  const inputs = inputsById || state.inputs;
  const merged = { ...state.inputs, ...inputs };
  const next = {
    ...state,
    tick: state.tick + 1,
    inputs: merged,
  };

  const activeId = matchSimActivePlayerId(next);
  const activeInput = activeId ? inputStateFor({ ...next, inputs: merged }, activeId) : createInputState();
  const dropHeld = rememberDropHeld(next, merged);

  if (next.match.phase === ONLINE_MATCH_PHASE.MATCH_OVER) {
    return { ...next, dropHeld, matchOverTicks: next.matchOverTicks + 1 };
  }

  let match = next.match;
  let world = next.world;
  let sounds = next.sounds;
  let startedThisTick = false;

  // A drop press is how a seat says "I am ready" as well as how it fires, so the turn start has to
  // consume the press — otherwise the same press would also spend a shot.
  if (
    activeInput.dropRequested
    && (match.phase === ONLINE_MATCH_PHASE.READY || match.phase === ONLINE_MATCH_PHASE.TURN_OVER)
  ) {
    match = startOnlineMatchTurn(match);
    world = createTurnWorld(match.round);
    startedThisTick = true;
  }

  if (match.phase !== ONLINE_MATCH_PHASE.PLAYING) {
    return { ...next, match, world, sounds, dropHeld };
  }

  let player = updatePlayer(world.player, activeInput);
  let poop = world.poop;
  let playSession = world.playSession;
  let npcs = world.npcs;

  if (!startedThisTick && activeInput.dropRequested && poop.phase === "inactive" && canFireShot(playSession)) {
    poop = spawnPoopFromPlayer(player);
    playSession = fireShot(playSession);
    sounds = queueOnlineSound(sounds, "poopRelease");
  }

  const previousPoopPhase = poop.phase;
  poop = updatePoop(poop);
  if (previousPoopPhase === "airborne" && poop.phase === "splat") {
    sounds = queueOnlineSound(sounds, "splat");
  }

  npcs = updateNpcState(npcs);
  const hitResult = processNpcHits(npcs.entities, poop);
  npcs = { ...npcs, entities: hitResult.entities };
  if (hitResult.scoreDelta > 0) {
    playSession = addScore(playSession, hitResult.scoreDelta);
    match = addOnlineMatchScore(match, hitResult.scoreDelta);
    sounds = queueOnlineNpcHitSounds(sounds, hitResult.hitTypes);
  }

  const previousSessionPhase = playSession.phase;
  playSession = updatePlaySession(playSession, poop);
  if (previousSessionPhase === "running" && playSession.phase === "game-over") {
    match = finishOnlineMatchTurn(match);
    world = createTurnWorld(match.round);
    return {
      ...next,
      match,
      world,
      sounds,
      dropHeld,
      matchOverTicks: match.phase === ONLINE_MATCH_PHASE.MATCH_OVER ? 0 : next.matchOverTicks,
    };
  }

  return {
    ...next,
    match,
    world: { player, poop, playSession, npcs },
    sounds,
    dropHeld,
    // The active seat's press has been spent; the held flag stays so the next press is a new edge.
    inputs: merged,
  };
}

/**
 * Retire the active seat's turn immediately, wherever it is in that turn.
 *
 * A turn normally ends when its magazine is empty and the last poop has landed, which means a seat
 * that stops playing — a dropped connection, a closed tab — would hold the match open forever.
 * Nobody else can act while it is not their turn, so there is no way out from inside the game. The
 * server calls this when a seat goes away; it is the only thing in this file that ends a turn
 * without the player having played it, and it is deliberately not reachable from a client message.
 */
export function forfeitMatchSimTurn(state, clientId) {
  if (!state) return state;
  if (state.match.phase === ONLINE_MATCH_PHASE.MATCH_OVER) return state;
  if (matchSimActivePlayerId(state) !== clientId) return state;

  // `finishOnlineMatchTurn` only retires a turn that is under way, so a seat that never pressed
  // start is walked through the same door rather than given a second code path.
  const playing = state.match.phase === ONLINE_MATCH_PHASE.PLAYING
    ? state.match
    : { ...state.match, phase: ONLINE_MATCH_PHASE.PLAYING };
  const match = finishOnlineMatchTurn(playing);

  return {
    ...state,
    match,
    world: createTurnWorld(match.round),
    matchOverTicks: match.phase === ONLINE_MATCH_PHASE.MATCH_OVER ? 0 : state.matchOverTicks,
  };
}

export function isMatchSimComplete(state) {
  return state?.match?.phase === ONLINE_MATCH_PHASE.MATCH_OVER;
}

export function isMatchSimFinished(state) {
  return isMatchSimComplete(state) && state.matchOverTicks >= MATCH_OVER_LINGER_TICKS;
}

/**
 * Shape the wire snapshot, and hand back the state with its sound queue drained.
 *
 * The queue has to be drained by *serializing* rather than by ticking, because snapshots go out
 * less often than ticks: a sound that happened in a skipped tick must still ride out on the next
 * snapshot instead of being lost, and must not ride out twice.
 */
export function serializeMatchSim(state, extras = {}) {
  const snapshot = {
    protocolVersion: state.protocolVersion,
    authorityMode: "server",
    tick: state.tick,
    tickRate: state.tickRate,
    match: {
      phase: state.match.phase,
      round: state.match.round,
      activeIndex: state.match.activeIndex,
      activeClientId: matchSimActivePlayerId(state),
      players: state.match.players.map((player) => ({ clientId: player.clientId, name: player.name })),
      scores: { ...state.match.scores },
      winnerClientId: state.match.winnerClientId,
      turnId: state.match.turnId,
    },
    world: {
      player: state.world.player,
      poop: state.world.poop,
      playSession: state.world.playSession,
      npcs: state.world.npcs,
    },
    sounds: [...state.sounds],
    ...extras,
  };

  return { snapshot, drained: { ...state, sounds: createOnlineSoundQueue() } };
}
