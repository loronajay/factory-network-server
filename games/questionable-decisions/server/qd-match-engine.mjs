// Questionable Decisions authoritative match engine. Pure functions only: clients
// submit intent (theme vote, tile pick, answer, penalty input) and receive
// public/private views. The server owns correctness, scoring, turn order, penalty
// selection, and match end (GDD section 14). Transport + timers live in the lobby
// adapter; this module never touches sockets.
import { sanitizeDisplayName } from "../../../src/util.mjs";
import {
  listThemes,
  buildBoard,
  isAnswerCorrect,
} from "./qd-content.mjs";
import { getPenalty, pickPenalty } from "./qd-penalties/registry.mjs";

export const QD_GAME_ID = "questionable-decisions";

export const QD_PHASES = Object.freeze({
  THEME_VOTE: "theme_vote",
  BOARD: "board",
  QUESTION: "question",
  ANSWER_REVEAL: "answer_reveal",
  PENALTY_INTRO: "penalty_intro",
  PENALTY_ACTIVE: "penalty_active",
  PENALTY_RESULTS: "penalty_results",
  SCOREBOARD: "scoreboard",
  MATCH_END: "match_end",
});

export const QD_CONFIG = Object.freeze({
  minimumPlayers: 2,
  maximumPlayers: 6,
  penaltyLossCapMultiplier: 1.5,
  durations: Object.freeze({
    theme_vote: 20_000,
    board: 25_000,
    question: 20_000,
    answer_reveal: 4_500,
    penalty_intro: 3_000,
    penalty_active: 15_000,
    penalty_results: 4_500,
    scoreboard: 4_000,
  }),
});

// Fixed match length by player count (GDD section 12).
const MATCH_TURNS_BY_PLAYER_COUNT = Object.freeze({ 2: 12, 3: 12, 4: 16, 5: 15, 6: 18 });

// Penalty mini-games are pluggable two-surface modules (see PENALTY_CONTRACT.md
// and qd-penalties/). The engine picks one on a wrong answer and delegates its
// state, input, scoring, and serialization to the module; only the loss envelope
// (cap + score floor) is owned here.

function clone(value) {
  return structuredClone(value);
}

function playerFor(match, clientId) {
  return match.players.find((player) => player.id === clientId) || null;
}

function connectedPlayers(match) {
  return match.players.filter((player) => player.connected);
}

// Deterministic RNG seeded from the lobby seed so penalty selection and
// tie-breaks are reproducible for replays/debugging.
function nextRandom(match) {
  match.rngState = (match.rngState * 1664525 + 1013904223) >>> 0;
  return match.rngState / 0xffffffff;
}

function activeQuestion(match) {
  return match.question || null;
}

function tileAt(match, categoryIndex, tileIndex) {
  const category = match.board?.categories?.[categoryIndex];
  return category ? category.tiles?.[tileIndex] || null : null;
}

function remainingTiles(match) {
  const tiles = [];
  (match.board?.categories || []).forEach((category, ci) => {
    category.tiles.forEach((tile, ti) => { if (!tile.used) tiles.push({ ci, ti }); });
  });
  return tiles;
}

function assertMatchRoster(lobby) {
  const count = lobby?.members?.size || 0;
  if (count < QD_CONFIG.minimumPlayers || count > QD_CONFIG.maximumPlayers) {
    throw new RangeError(`Questionable Decisions requires ${QD_CONFIG.minimumPlayers}-${QD_CONFIG.maximumPlayers} players.`);
  }
}

export function createQDMatchState(lobby, now = Date.now()) {
  assertMatchRoster(lobby);
  const members = [...lobby.members];
  const players = members.map((id, index) => ({
    id,
    clientId: id,
    name: sanitizeDisplayName(lobby?.memberProfiles?.get(id)?.displayName, `Player ${index + 1}`),
    score: 0,
    streak: 0,
    correctCount: 0,
    connected: true,
  }));
  return {
    gameId: QD_GAME_ID,
    roomCode: lobby.roomCode,
    hostId: lobby.ownerId,
    phase: QD_PHASES.THEME_VOTE,
    turn: 0,
    maxTurns: MATCH_TURNS_BY_PLAYER_COUNT[members.length] || 12,
    themes: listThemes().map((theme) => ({ ...theme, votes: 0 })),
    themeVotes: {},
    selectedThemeId: null,
    themeTitle: null,
    board: null,
    players,
    turnOrder: members.slice(),
    turnPointer: 0,
    activePlayerId: members[0],
    question: null,
    answers: {},
    answerReveal: null,
    keepControl: false,
    penalty: null,
    winnerPlayerId: null,
    rngState: (Math.abs(Math.floor(Number(lobby?.seed) || 0)) || 1) >>> 0,
    createdAt: now,
    updatedAt: now,
  };
}

function tallyThemeVotes(match) {
  const counts = Object.fromEntries(match.themes.map((theme) => [theme.id, 0]));
  for (const themeId of Object.values(match.themeVotes)) if (themeId in counts) counts[themeId] += 1;
  return counts;
}

export function submitThemeVote(match, clientId, themeId, now = Date.now()) {
  if (match?.phase !== QD_PHASES.THEME_VOTE) return match;
  if (!playerFor(match, clientId)?.connected) return match;
  if (!match.themes.some((theme) => theme.id === themeId)) return match;
  const next = clone(match);
  next.themeVotes[clientId] = themeId;
  const counts = tallyThemeVotes(next);
  next.themes = next.themes.map((theme) => ({ ...theme, votes: counts[theme.id] || 0 }));
  next.updatedAt = now;
  return next;
}

// Everyone connected has voted — let the adapter resolve early.
export function allThemeVotesIn(match) {
  if (match?.phase !== QD_PHASES.THEME_VOTE) return false;
  return connectedPlayers(match).every((player) => match.themeVotes[player.id]);
}

export function resolveThemeVote(match, now = Date.now()) {
  if (match?.phase !== QD_PHASES.THEME_VOTE) return match;
  const next = clone(match);
  const counts = tallyThemeVotes(next);
  const top = Math.max(0, ...Object.values(counts));
  let leaders = next.themes.map((theme) => theme.id).filter((id) => counts[id] === top);
  if (top === 0) leaders = next.themes.map((theme) => theme.id);
  const winner = leaders[Math.floor(nextRandom(next) * leaders.length)] || next.themes[0].id;

  next.selectedThemeId = winner;
  const board = buildBoard(winner);
  next.board = board;
  next.themeTitle = board?.title || null;
  next.phase = QD_PHASES.BOARD;
  next.turn = 1;
  next.updatedAt = now;
  return next;
}

export function selectTile(match, clientId, categoryIndex, tileIndex, now = Date.now()) {
  if (match?.phase !== QD_PHASES.BOARD) return match;
  if (clientId !== match.activePlayerId) return match;
  const tile = tileAt(match, categoryIndex, tileIndex);
  if (!tile || tile.used) return match;
  return openTile(match, categoryIndex, tileIndex, now);
}

// Board timeout: auto-pick a random remaining tile so play never stalls.
export function autoSelectTile(match, now = Date.now()) {
  if (match?.phase !== QD_PHASES.BOARD) return match;
  const remaining = remainingTiles(match);
  if (!remaining.length) return endMatch(clone(match), now);
  const next = clone(match);
  const pick = remaining[Math.floor(nextRandom(next) * remaining.length)];
  return openTile(next, pick.ci, pick.ti, now, /* alreadyCloned */ true);
}

function openTile(match, categoryIndex, tileIndex, now, alreadyCloned = false) {
  const next = alreadyCloned ? match : clone(match);
  const tile = tileAt(next, categoryIndex, tileIndex);
  tile.used = true;
  next.question = { ...clone(tile.question), categoryIndex, tileIndex };
  next.answers = {};
  next.answerReveal = null;
  next.phase = QD_PHASES.QUESTION;
  next.updatedAt = now;
  return next;
}

export function submitAnswer(match, clientId, answer, now = Date.now()) {
  if (match?.phase !== QD_PHASES.QUESTION) return match;
  if (clientId !== match.activePlayerId) return match;
  if (match.answers[clientId] != null) return match;
  const next = clone(match);
  next.answers[clientId] = String(answer ?? "");
  next.updatedAt = now;
  return resolveAnswer(next, now);
}

export function resolveAnswer(match, now = Date.now()) {
  if (match?.phase !== QD_PHASES.QUESTION) return match;
  const next = clone(match);
  const question = activeQuestion(next);
  const submitted = next.answers[next.activePlayerId];
  const correct = submitted != null && isAnswerCorrect(question, submitted);
  const player = playerFor(next, next.activePlayerId);

  if (correct) {
    player.score += question.points;
    player.streak += 1;
    player.correctCount += 1;
    next.keepControl = true;
  } else {
    player.streak = 0;
    next.keepControl = false;
  }

  next.answerReveal = { correct, correctAnswer: question.answer, playerId: next.activePlayerId, points: question.points };
  next.phase = QD_PHASES.ANSWER_REVEAL;
  next.updatedAt = now;
  return next;
}

// After the reveal: correct keeps control (straight to scoreboard); wrong drops
// into the penalty mini-game.
export function advanceAfterReveal(match, now = Date.now()) {
  if (match?.phase !== QD_PHASES.ANSWER_REVEAL) return match;
  const next = clone(match);
  next.phase = next.keepControl ? QD_PHASES.SCOREBOARD : QD_PHASES.PENALTY_INTRO;
  next.updatedAt = now;
  return next;
}

export function beginPenalty(match, now = Date.now()) {
  if (match?.phase !== QD_PHASES.PENALTY_INTRO) return match;
  const next = clone(match);
  const descriptor = pickPenalty(() => nextRandom(next));
  const sourceValue = next.answerReveal?.points || next.question?.points || 100;
  const maxLoss = Math.round(sourceValue * QD_CONFIG.penaltyLossCapMultiplier);
  const seed = Math.floor(nextRandom(next) * 1e9);
  const state = descriptor.init({ sourceValue, maxLoss, seed });
  next.penalty = {
    penaltyId: descriptor.penaltyId,
    displayName: descriptor.displayName,
    promptText: descriptor.promptText,
    activePlayerId: next.activePlayerId,
    sourceValue,
    maxLoss,
    state,
    pointsLost: null,
    statusText: descriptor.status(state),
  };
  next.phase = QD_PHASES.PENALTY_ACTIVE;
  next.updatedAt = now;
  return next;
}

export function submitPenaltyInput(match, clientId, input, now = Date.now()) {
  if (match?.phase !== QD_PHASES.PENALTY_ACTIVE) return match;
  if (!match.penalty || clientId !== match.penalty.activePlayerId) return match;
  const descriptor = getPenalty(match.penalty.penaltyId);
  const next = clone(match);
  next.penalty.state = descriptor.input(next.penalty.state, String(input ?? ""));
  next.penalty.statusText = descriptor.status(next.penalty.state);
  next.updatedAt = now;
  return next;
}

export function resolvePenalty(match, now = Date.now()) {
  if (match?.phase !== QD_PHASES.PENALTY_ACTIVE) return match;
  const next = clone(match);
  const penalty = next.penalty;
  const descriptor = getPenalty(penalty.penaltyId);
  const result = descriptor.resolve(penalty.state, { maxLoss: penalty.maxLoss });
  const pointsLost = Math.max(0, Math.min(penalty.maxLoss, Math.round(result.pointsLost)));
  penalty.pointsLost = pointsLost;
  penalty.statusText = result.statusText;

  const player = playerFor(next, penalty.activePlayerId);
  player.score = Math.max(0, player.score - pointsLost);

  next.phase = QD_PHASES.PENALTY_RESULTS;
  next.updatedAt = now;
  return next;
}

export function advanceAfterPenalty(match, now = Date.now()) {
  if (match?.phase !== QD_PHASES.PENALTY_RESULTS) return match;
  const next = clone(match);
  next.phase = QD_PHASES.SCOREBOARD;
  next.updatedAt = now;
  return next;
}

// Scoreboard ends the turn: keep or pass control, then either start the next
// question or end the match (turn budget spent / board cleared).
export function advanceTurn(match, now = Date.now()) {
  if (match?.phase !== QD_PHASES.SCOREBOARD) return match;
  const next = clone(match);

  if (next.turn >= next.maxTurns || remainingTiles(next).length === 0) {
    return endMatch(next, now);
  }

  if (!next.keepControl) {
    next.turnPointer = (next.turnPointer + 1) % next.turnOrder.length;
    next.activePlayerId = next.turnOrder[next.turnPointer];
  }
  next.turn += 1;
  next.question = null;
  next.answers = {};
  next.answerReveal = null;
  next.penalty = null;
  next.keepControl = false;
  next.phase = QD_PHASES.BOARD;
  next.updatedAt = now;
  return next;
}

function endMatch(next, now) {
  const ranked = next.players.slice().sort((a, b) => (b.score - a.score) || (b.correctCount - a.correctCount));
  const top = ranked[0];
  const tiedTop = ranked.filter((player) => player.score === top.score && player.correctCount === top.correctCount);
  const winner = tiedTop.length > 1 ? tiedTop[Math.floor(nextRandom(next) * tiedTop.length)] : top;
  next.winnerPlayerId = winner?.id || null;
  next.phase = QD_PHASES.MATCH_END;
  next.question = null;
  next.penalty = null;
  next.updatedAt = now;
  return next;
}

export function applyQDConnection(match, clientId, connected, now = Date.now()) {
  const player = playerFor(match, clientId);
  if (!player || player.connected === !!connected) return match;
  const next = clone(match);
  playerFor(next, clientId).connected = !!connected;
  next.updatedAt = now;
  return next;
}

// --- serialization: never leak unrevealed answers ---

function publicQuestion(match) {
  const question = activeQuestion(match);
  if (!question) return null;
  if (match.phase !== QD_PHASES.QUESTION && match.phase !== QD_PHASES.ANSWER_REVEAL) return null;
  return {
    category: question.category,
    points: question.points,
    format: question.format,
    prompt: question.prompt,
    choices: question.choices ? [...question.choices] : null,
  };
}

function publicBoard(match) {
  if (!match.board) return null;
  return {
    title: match.board.title,
    categories: match.board.categories.map((category) => ({
      id: category.id,
      title: category.title,
      tiles: category.tiles.map((tile) => ({ points: tile.points, used: tile.used })),
    })),
  };
}

function publicPenalty(match) {
  if (!match.penalty) return null;
  const descriptor = getPenalty(match.penalty.penaltyId);
  const { penaltyId, displayName, promptText, activePlayerId, statusText, pointsLost, state } = match.penalty;
  return {
    penaltyId,
    displayName,
    promptText,
    activePlayerId,
    statusText,
    ...(pointsLost != null ? { pointsLost } : {}),
    ...descriptor.serializePublic(state),
  };
}

export function serializeQDPublicState(match) {
  return {
    gameId: match.gameId,
    phase: match.phase,
    turn: match.turn,
    maxTurns: match.maxTurns,
    themeTitle: match.themeTitle,
    activePlayerId: match.activePlayerId,
    themes: match.phase === QD_PHASES.THEME_VOTE ? match.themes.map((theme) => ({ id: theme.id, title: theme.title, votes: theme.votes })) : null,
    board: publicBoard(match),
    question: publicQuestion(match),
    answerReveal: match.phase === QD_PHASES.ANSWER_REVEAL && match.answerReveal ? { ...match.answerReveal } : null,
    penalty: publicPenalty(match),
    players: match.players.map(({ id, name, score, streak, connected }) => ({ id, name, score, streak, connected })),
    winnerPlayerId: match.winnerPlayerId,
  };
}

export function serializeQDPrivateState(match, clientId) {
  const player = playerFor(match, clientId);
  if (!player) return null;
  const isActive = clientId === match.activePlayerId;
  const inPenalty = match.phase === QD_PHASES.PENALTY_ACTIVE && match.penalty?.activePlayerId === clientId;
  return {
    ...serializeQDPublicState(match),
    me: {
      id: player.id,
      score: player.score,
      streak: player.streak,
      themeVote: match.themeVotes[clientId] || null,
      canSelectTile: match.phase === QD_PHASES.BOARD && isActive && player.connected,
      canAnswer: match.phase === QD_PHASES.QUESTION && isActive && match.answers[clientId] == null,
      submittedAnswer: match.answers[clientId] != null,
      inPenalty,
      penalty: inPenalty
        ? {
            penaltyId: match.penalty.penaltyId,
            promptText: match.penalty.promptText,
            ...getPenalty(match.penalty.penaltyId).serializePrivate(match.penalty.state),
          }
        : null,
    },
  };
}
