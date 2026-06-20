// Echo Duel authoritative match engine — pure state transitions only.
// Every function returns a new match object (or the same reference when nothing
// changed); nothing here touches sockets, timers, or shared server state. The
// lobby adapter (echo-duel-lobby-game.mjs) owns serialization, broadcasting and
// timer scheduling.
import { ECHO_DUEL_GAME_ID } from "../../../src/state.mjs";
import { sanitizePenaltyWord, sanitizeDisplayName, lobbyPlayerCount } from "../../../src/util.mjs";

export const ECHO_INPUTS = ["W", "A", "S", "D"];
export const ECHO_PHASES = {
  OWNER_CREATE_INITIAL: "owner_create_initial",
  OWNER_REPLAY: "owner_replay",
  OWNER_APPEND: "owner_append",
  SIGNAL_PLAYBACK: "signal_playback",
  CHALLENGER_COPY: "challenger_copy",
  MATCH_OVER: "match_over",
};
const ECHO_PLAYBACK_TIMING = {
  stepMs: 450,
  gapMs: 120,
  holdMs: 700,
};
const DEFAULT_ECHO_SETTINGS = {
  startingPatternLength: 4,
  patternAppendCount: 2,
  maxPatternLength: 10,
  timerSecondsPerInput: 1.25,
  minTimerSeconds: 6,
  maxTimerSeconds: 13,
  penaltyWord: "STATIC",
};

function createEchoPlayersFromLobby(lobby) {
  const memberIds = lobby?.members ? [...lobby.members] : [];
  return memberIds.map((clientId, index) => {
    const profile = lobby?.memberProfiles instanceof Map ? lobby.memberProfiles.get(clientId) : null;
    return {
      id: clientId,
      clientId,
      name: sanitizeDisplayName(profile?.displayName, `Player ${index + 1}`),
      letters: "",
      eliminated: false,
      lastResult: null,
    };
  });
}

function buildEchoSettings(lobby) {
  return {
    ...DEFAULT_ECHO_SETTINGS,
    penaltyWord: sanitizePenaltyWord(lobby?.settings?.penaltyWord || DEFAULT_ECHO_SETTINGS.penaltyWord),
    playerCount: lobbyPlayerCount(lobby),
  };
}

function cloneEchoTimer(timer) {
  return timer ? { ...timer } : null;
}

function cloneEchoPlayback(playback) {
  return playback
    ? { ...playback, sequence: [...(playback.sequence || [])] }
    : null;
}

export function cloneEchoMatch(match) {
  return {
    ...match,
    settings: { ...match.settings },
    players: match.players.map((player) => ({ ...player })),
    activeSequence: [...match.activeSequence],
    ownerDraft: [...match.ownerDraft],
    copyProgress: Object.fromEntries(
      Object.entries(match.copyProgress || {}).map(([playerId, progress]) => [playerId, { ...progress }])
    ),
    roundResults: (match.roundResults || []).map((result) => ({ ...result })),
    timer: cloneEchoTimer(match.timer),
    playback: cloneEchoPlayback(match.playback),
    inputCursor: { ...(match.inputCursor || {}) },
  };
}

function echoActivePlayers(match) {
  return match.players.filter((player) => !player.eliminated);
}

function echoGetOwner(match) {
  return match.players[match.ownerIndex] || null;
}

function echoFindPlayerIndex(match, clientId) {
  return match.players.findIndex((player) => player.clientId === clientId || player.id === clientId);
}

function echoFirstActiveIndex(match) {
  return match.players.findIndex((player) => !player.eliminated);
}

function echoNextActiveIndex(match, fromIndex) {
  if (echoActivePlayers(match).length <= 0) return -1;
  for (let offset = 1; offset <= match.players.length; offset += 1) {
    const index = (fromIndex + offset) % match.players.length;
    if (!match.players[index]?.eliminated) return index;
  }
  return -1;
}

function echoTimerForLength(length, settings, now) {
  const raw = Number(length || 0) * Number(settings.timerSecondsPerInput || 1);
  const seconds = Math.max(Number(settings.minTimerSeconds || 0), Math.min(Number(settings.maxTimerSeconds || raw), raw));
  return {
    startedAt: now,
    durationMs: seconds * 1000,
    endsAt: now + (seconds * 1000),
  };
}

function echoAdvancePhase(match, phase, { newTurn = false } = {}) {
  match.phase = phase;
  match.phaseId = Number(match.phaseId || 0) + 1;
  if (newTurn) match.turnId = Number(match.turnId || 0) + 1;
  return match;
}

function echoAppendTargetLength(match) {
  const current = Number(match.activeSequence.length || 0);
  const appendCount = Math.max(1, Number(match.settings.patternAppendCount || 1));
  const maxLength = Math.max(current, Number(match.settings.maxPatternLength || current));
  return Math.min(maxLength, current + appendCount);
}

function echoRemainingAppendInputs(match) {
  return Math.max(0, Number(match.appendTargetLength || echoAppendTargetLength(match)) - Number(match.activeSequence.length || 0));
}

function echoClearPlayerResults(players) {
  return players.map((player) => ({ ...player, lastResult: null }));
}

function echoSetPlayerResult(players, playerId, result) {
  return players.map((player) => (
    player.id === playerId ? { ...player, lastResult: result } : player
  ));
}

function echoAwardLetter(match, playerIndex) {
  const next = cloneEchoMatch(match);
  const player = next.players[playerIndex];
  if (!player || player.eliminated) return next;

  const nextLetter = next.settings.penaltyWord[player.letters.length] || "";
  player.letters += nextLetter;
  player.lastResult = "fail";
  if (player.letters.length >= next.settings.penaltyWord.length) {
    player.eliminated = true;
    player.lastResult = "eliminated";
  }
  return next;
}

function echoBeginControl(match, ownerIndex, status = "") {
  const next = cloneEchoMatch(match);
  const safeOwner = ownerIndex >= 0 ? ownerIndex : echoFirstActiveIndex(next);
  echoAdvancePhase(next, ECHO_PHASES.OWNER_CREATE_INITIAL, { newTurn: true });
  next.ownerIndex = safeOwner >= 0 ? safeOwner : 0;
  next.activeSequence = [];
  next.ownerDraft = [];
  next.ownerReplayIndex = 0;
  next.appendTargetLength = 0;
  next.copyProgress = {};
  next.roundResults = [];
  next.timer = null;
  next.playback = null;
  next.players = echoClearPlayerResults(next.players);
  next.status = status || `${echoGetOwner(next)?.name || "Owner"} has control. Create a 4-input pattern.`;
  return next;
}

function echoBeginOwnerReplay(match, now) {
  const next = cloneEchoMatch(match);
  echoAdvancePhase(next, ECHO_PHASES.OWNER_REPLAY);
  next.ownerReplayIndex = 0;
  next.ownerDraft = [];
  next.appendTargetLength = 0;
  next.copyProgress = {};
  next.timer = echoTimerForLength(next.activeSequence.length, next.settings, now);
  next.playback = null;
  next.players = echoClearPlayerResults(next.players);
  next.status = `${echoGetOwner(next)?.name || "Owner"} must replay the ${next.activeSequence.length}-input sequence.`;
  return next;
}

function echoBeginChallengerCopy(match, now) {
  const next = cloneEchoMatch(match);
  echoAdvancePhase(next, ECHO_PHASES.CHALLENGER_COPY);
  next.copyProgress = {};
  next.roundResults = [];
  next.players = echoClearPlayerResults(next.players);
  for (const player of next.players) {
    if (!player.eliminated && player.id !== echoGetOwner(next)?.id) {
      next.copyProgress[player.id] = { index: 0, status: "copying", finishedAt: null };
    }
  }
  next.timer = echoTimerForLength(next.activeSequence.length, next.settings, now);
  next.playback = null;
  const count = Object.keys(next.copyProgress).length;
  next.status = count > 1
    ? `${count} challengers copy the ${next.activeSequence.length}-input pattern.`
    : `Challenger copies the ${next.activeSequence.length}-input pattern.`;
  return next;
}

function echoBeginSignalPlayback(match, now, status = "") {
  const next = cloneEchoMatch(match);
  const sequence = [...next.activeSequence].slice(0, Number(next.settings.maxPatternLength || 10));
  const stepMs = Number(ECHO_PLAYBACK_TIMING.stepMs || 450);
  const gapMs = Number(ECHO_PLAYBACK_TIMING.gapMs || 120);
  const holdMs = Number(ECHO_PLAYBACK_TIMING.holdMs || 700);
  const perInputMs = stepMs + gapMs;
  const totalMs = sequence.length * perInputMs + holdMs;

  echoAdvancePhase(next, ECHO_PHASES.SIGNAL_PLAYBACK);
  next.activeSequence = sequence;
  next.timer = null;
  next.copyProgress = {};
  next.roundResults = [];
  next.playback = {
    id: `${next.turnId}:${next.phaseId}:${sequence.join("")}`,
    sequence,
    startedAt: now,
    stepMs,
    gapMs,
    holdMs,
    perInputMs,
    totalMs,
    endsAt: now + totalMs,
  };
  next.status = status || `Memorize the ${sequence.length}-input signal.`;
  return next;
}

function echoFinishSignalPlayback(match, now) {
  const next = cloneEchoMatch(match);
  next.playback = null;
  return echoBeginChallengerCopy(next, now);
}

function echoFinishCopyPhase(match, now) {
  let next = cloneEchoMatch(match);
  const active = echoActivePlayers(next);
  if (active.length <= 1) {
    echoAdvancePhase(next, ECHO_PHASES.MATCH_OVER);
    next.winnerId = active[0]?.id || null;
    next.status = `${active[0]?.name || "No one"} wins.`;
    next.timer = null;
    return next;
  }

  const owner = echoGetOwner(next);
  const challengerIds = Object.keys(next.copyProgress || {});
  const successful = next.roundResults.filter((result) => result.result === "safe");
  const allChallengersSucceeded = challengerIds.length > 0 && successful.length === challengerIds.length;
  const reachedMax = next.activeSequence.length >= next.settings.maxPatternLength;

  if (!allChallengersSucceeded) {
    const ownerIndex = next.players.findIndex((player) => player.id === owner?.id);
    return echoBeginControl(
      next,
      ownerIndex >= 0 ? ownerIndex : next.ownerIndex,
      `${owner?.name || "Owner"} keeps control. Not everyone copied it, so the signal resets.`
    );
  }

  if (reachedMax) {
    const fastest = [...successful].sort((left, right) => Number(left.finishedAt || 0) - Number(right.finishedAt || 0))[0];
    const winnerIndex = next.players.findIndex((player) => player.id === fastest?.playerId);
    const safeIndex = winnerIndex >= 0 ? winnerIndex : echoNextActiveIndex(next, next.ownerIndex);
    return echoBeginControl(next, safeIndex, `${next.players[safeIndex]?.name || "Next player"} survived the 10-input chain and takes control.`);
  }

  next.status = `${owner?.name || "Owner"} keeps control. Everyone copied it, so the signal can grow.`;
  return echoBeginOwnerReplay(next, now);
}

function echoMarkChallengerResult(match, playerId, result, now) {
  let next = cloneEchoMatch(match);
  const progress = next.copyProgress[playerId];
  if (!progress || progress.status !== "copying") return next;

  progress.status = result;
  progress.finishedAt = now;
  next.roundResults.push({ playerId, result, finishedAt: progress.finishedAt });

  const playerIndex = next.players.findIndex((player) => player.id === playerId);
  if (result === "fail") {
    next = echoAwardLetter(next, playerIndex);
  } else {
    next.players = echoSetPlayerResult(next.players, playerId, "safe");
  }

  const active = echoActivePlayers(next);
  if (active.length <= 1) {
    echoAdvancePhase(next, ECHO_PHASES.MATCH_OVER);
    next.winnerId = active[0]?.id || null;
    next.status = `${active[0]?.name || "No one"} wins.`;
    next.timer = null;
    return next;
  }

  const unresolved = Object.values(next.copyProgress).some((item) => item.status === "copying");
  if (!unresolved) return echoFinishCopyPhase(next, now);

  const remaining = Object.values(next.copyProgress).filter((item) => item.status === "copying").length;
  next.status = `${remaining} challenger${remaining === 1 ? "" : "s"} still copying.`;
  return next;
}

function echoActorIndexForPhase(match, clientId) {
  if (clientId) return echoFindPlayerIndex(match, clientId);
  if (match.phase === ECHO_PHASES.CHALLENGER_COPY) {
    const nextCopyingId = Object.entries(match.copyProgress || {}).find(([, progress]) => progress.status === "copying")?.[0];
    return nextCopyingId ? echoFindPlayerIndex(match, nextCopyingId) : -1;
  }
  return match.ownerIndex;
}

export function createEchoDuelMatchState(lobby, now = Date.now()) {
  const players = createEchoPlayersFromLobby(lobby);
  const count = players.length;
  const settings = buildEchoSettings(lobby);
  const seed = Number.isFinite(Number(lobby?.seed)) ? Math.abs(Number(lobby.seed)) : 0;
  const ownerIndex = count > 0 ? seed % count : 0;
  return {
    roomCode: lobby.roomCode,
    gameId: ECHO_DUEL_GAME_ID,
    phase: ECHO_PHASES.OWNER_CREATE_INITIAL,
    turnId: 1,
    phaseId: 1,
    settings,
    players,
    ownerIndex,
    activeSequence: [],
    ownerReplayIndex: 0,
    ownerDraft: [],
    appendTargetLength: 0,
    copyProgress: {},
    roundResults: [],
    winnerId: null,
    status: `${players[ownerIndex]?.name || "Owner"} starts control. Create a 4-input pattern.`,
    timer: null,
    playback: null,
    inputCursor: {},
    createdAt: now,
  };
}

export function applyEchoInputToMatch(match, clientId, rawInput, meta = null, now = Date.now()) {
  if (now < Number(match.createdAt || 0)) return match;

  const input = String(rawInput || "").toUpperCase();
  if (!ECHO_INPUTS.includes(input)) return match;
  const inputId = Number(meta?.inputId);
  if (meta) {
    const phaseId = Number(meta.phaseId);
    const turnId = Number(meta.turnId);
    if (!Number.isFinite(phaseId) || !Number.isFinite(turnId)) return match;
    if (phaseId !== Number(match.phaseId || 0) || turnId !== Number(match.turnId || 0)) return match;
  }
  if (Number.isFinite(inputId) && inputId > 0 && inputId <= Number(match.inputCursor?.[clientId] || 0)) {
    return match;
  }

  let next = cloneEchoMatch(match);
  const actorIndex = echoActorIndexForPhase(next, clientId);
  const actor = next.players[actorIndex];
  const owner = echoGetOwner(next);
  if (!actor || actor.eliminated) return match;
  const rememberInput = () => {
    if (Number.isFinite(inputId) && inputId > 0) {
      next.inputCursor[actor.id] = inputId;
      next.inputCursor[actor.clientId] = inputId;
    }
  };

  if (next.phase === ECHO_PHASES.OWNER_CREATE_INITIAL) {
    if (actor.id !== owner?.id && actor.clientId !== owner?.clientId) return match;
    next.ownerDraft.push(input);
    rememberInput();
    if (next.ownerDraft.length >= next.settings.startingPatternLength) {
      next.activeSequence = [...next.ownerDraft];
      next.ownerDraft = [];
      next.status = `${owner?.name || "Owner"} set the starting pattern.`;
      return echoBeginSignalPlayback(next, now, `${owner?.name || "Owner"} set the starting signal. Memorize it.`);
    }
    next.status = `${owner?.name || "Owner"} is creating the starting pattern.`;
    return next;
  }

  if (next.phase === ECHO_PHASES.OWNER_REPLAY) {
    if (actor.id !== owner?.id && actor.clientId !== owner?.clientId) return match;
    const expected = next.activeSequence[next.ownerReplayIndex];
    rememberInput();
    if (input !== expected) {
      next.players = echoSetPlayerResult(next.players, owner?.id, "owner-fail");
      const passTo = echoNextActiveIndex(next, next.ownerIndex);
      return echoBeginControl(next, passTo, `${owner?.name || "Owner"} dropped their own pattern. Control passes.`);
    }

    next.ownerReplayIndex += 1;
    if (next.ownerReplayIndex >= next.activeSequence.length) {
      echoAdvancePhase(next, ECHO_PHASES.OWNER_APPEND);
      next.appendTargetLength = echoAppendTargetLength(next);
      const needed = echoRemainingAppendInputs(next);
      next.timer = echoTimerForLength(Math.max(1, needed), next.settings, now);
      next.status = `${owner?.name || "Owner"} replayed it. Add ${needed} new input${needed === 1 ? "" : "s"}.`;
    } else {
      next.status = `${owner?.name || "Owner"} replaying: ${next.ownerReplayIndex}/${next.activeSequence.length}.`;
    }
    return next;
  }

  if (next.phase === ECHO_PHASES.OWNER_APPEND) {
    if (actor.id !== owner?.id && actor.clientId !== owner?.clientId) return match;
    if (!next.appendTargetLength || next.appendTargetLength <= next.activeSequence.length) {
      next.appendTargetLength = echoAppendTargetLength(next);
    }
    const maxLength = Number(next.settings.maxPatternLength || next.appendTargetLength || next.activeSequence.length);
    next.appendTargetLength = Math.min(next.appendTargetLength, maxLength);
    if (next.activeSequence.length >= next.appendTargetLength || next.activeSequence.length >= maxLength) {
      next.status = `${owner?.name || "Owner"} hit the ${maxLength}-input cap. Memorize it.`;
      next.appendTargetLength = 0;
      return echoBeginSignalPlayback(next, now, `${owner?.name || "Owner"} hit the ${maxLength}-input cap. Memorize it.`);
    }

    next.activeSequence.push(input);
    rememberInput();
    if (next.activeSequence.length > maxLength) {
      next.activeSequence = next.activeSequence.slice(0, maxLength);
    }
    const remaining = echoRemainingAppendInputs(next);
    if (remaining > 0) {
      next.status = `${owner?.name || "Owner"} adding inputs: ${next.activeSequence.length}/${next.appendTargetLength}.`;
      return next;
    }
    next.status = `${owner?.name || "Owner"} extended the pattern to ${next.activeSequence.length}.`;
    next.appendTargetLength = 0;
    return echoBeginSignalPlayback(next, now, `${owner?.name || "Owner"} extended the signal to ${next.activeSequence.length}. Memorize it.`);
  }

  if (next.phase === ECHO_PHASES.CHALLENGER_COPY) {
    if (actor.id === owner?.id || actor.clientId === owner?.clientId) return match;
    const progress = next.copyProgress[actor.id];
    if (!progress || progress.status !== "copying") return match;

    const expected = next.activeSequence[progress.index];
    rememberInput();
    if (input !== expected) {
      return echoMarkChallengerResult(next, actor.id, "fail", now);
    }

    progress.index += 1;
    if (progress.index >= next.activeSequence.length) {
      return echoMarkChallengerResult(next, actor.id, "safe", now);
    }
    next.status = `${actor.name} copying: ${progress.index}/${next.activeSequence.length}.`;
    return next;
  }

  return next;
}

export function advanceEchoMatchToTime(match, now = Date.now()) {
  if (match.phase === ECHO_PHASES.SIGNAL_PLAYBACK && match.playback) {
    if (now >= match.playback.endsAt) return echoFinishSignalPlayback(match, now);
    return match;
  }

  if (!match.timer) return match;
  if (now < match.timer.endsAt) return match;

  let next = cloneEchoMatch(match);
  if (next.phase === ECHO_PHASES.OWNER_REPLAY || next.phase === ECHO_PHASES.OWNER_APPEND) {
    const owner = echoGetOwner(next);
    const passTo = echoNextActiveIndex(next, next.ownerIndex);
    return echoBeginControl(next, passTo, `${owner?.name || "Owner"} ran out of time. Control passes.`);
  }

  if (next.phase === ECHO_PHASES.CHALLENGER_COPY) {
    const failingIds = Object.entries(next.copyProgress || {})
      .filter(([, progress]) => progress.status === "copying")
      .map(([playerId]) => playerId);

    for (const playerId of failingIds) {
      next = echoMarkChallengerResult(next, playerId, "fail", now);
      if (next.phase === ECHO_PHASES.MATCH_OVER) return next;
    }
  }

  return next;
}

export function applyEchoDisconnectToMatch(match, clientId, now = Date.now()) {
  if (!match || match.phase === ECHO_PHASES.MATCH_OVER) return match;

  const leavingPlayer = match.players.find((player) => player.clientId === clientId || player.id === clientId);
  const activeBefore = echoActivePlayers(match).length;
  if (!leavingPlayer || leavingPlayer.eliminated) return match;

  if (activeBefore <= 2) {
    const closed = cloneEchoMatch(match);
    closed.phase = ECHO_PHASES.MATCH_OVER;
    closed.winnerId = null;
    closed.timer = null;
    closed.playback = null;
    closed.status = `${leavingPlayer.name} disconnected. The match was closed.`;
    return closed;
  }

  let next = cloneEchoMatch(match);
  const leavingIndex = next.players.findIndex((player) => player.clientId === clientId || player.id === clientId);
  if (leavingIndex < 0) return match;

  next.players[leavingIndex] = {
    ...next.players[leavingIndex],
    eliminated: true,
    lastResult: "disconnected",
  };
  delete next.copyProgress[next.players[leavingIndex].id];

  const remaining = next.players.filter((player) => !player.eliminated);
  if (remaining.length <= 1) {
    next.phase = ECHO_PHASES.MATCH_OVER;
    next.winnerId = remaining[0]?.id || null;
    next.timer = null;
    next.playback = null;
    next.status = `${remaining[0]?.name || "No one"} wins after a disconnect.`;
    return next;
  }

  const leavingWasOwner = leavingIndex === next.ownerIndex;
  if (leavingWasOwner) {
    const nextOwnerIndex = echoNextActiveIndex(next, leavingIndex);
    return echoBeginControl(
      next,
      nextOwnerIndex >= 0 ? nextOwnerIndex : 0,
      `${leavingPlayer.name} disconnected. ${next.players[nextOwnerIndex]?.name || "Next player"} takes control.`
    );
  }

  if (next.phase === ECHO_PHASES.CHALLENGER_COPY) {
    const unresolved = Object.values(next.copyProgress || {}).some((progress) => progress.status === "copying");
    if (!unresolved) {
      next = echoFinishCopyPhase(next, now);
      next.status = `${leavingPlayer.name} disconnected and was removed from the match.`;
      return next;
    }
  }

  next.status = `${leavingPlayer.name} disconnected and was removed from the match.`;
  return next;
}

// Pure: the next wall-clock deadline this match is waiting on, or null.
export function nextEchoMatchDeadline(match) {
  if (!match) return null;
  if (match.phase === ECHO_PHASES.SIGNAL_PLAYBACK && match.playback?.endsAt) {
    return match.playback.endsAt;
  }
  if (match.timer?.endsAt) return match.timer.endsAt;
  return null;
}

// Pure: which authoritative message type a snapshot of this match represents.
export function getEchoAuthorityMessageType(match) {
  if (!match) return "match_state";
  if (match.phase === ECHO_PHASES.SIGNAL_PLAYBACK) return "signal_playback";
  if (match.phase === ECHO_PHASES.MATCH_OVER) return "match_ended";
  return "match_state";
}

// Pure: client-facing snapshot with countdown-friendly remaining times and the
// network/authority metadata clients expect. Does not broadcast.
export function serializeEchoMatchState(match, lobby, now = Date.now()) {
  const snapshot = cloneEchoMatch(match);
  delete snapshot.inputCursor;
  if (snapshot.timer) {
    snapshot.timer = {
      durationMs: snapshot.timer.durationMs,
      remainingMs: Math.max(0, snapshot.timer.endsAt - now),
    };
  }
  if (snapshot.playback) {
    snapshot.playback = {
      ...snapshot.playback,
      sequence: [...(snapshot.playback.sequence || [])],
      remainingMs: Math.max(0, snapshot.playback.endsAt - now),
    };
    delete snapshot.playback.endsAt;
  }
  snapshot.mode = "online";
  snapshot.network = {
    roomCode: lobby?.roomCode || match.roomCode,
    hostId: lobby?.ownerId || null,
    lobbyOwnerId: lobby?.ownerId || null,
    authorityMode: "server",
    syncSeq: Number(lobby?.echoSyncSeq || 0),
  };
  return snapshot;
}
