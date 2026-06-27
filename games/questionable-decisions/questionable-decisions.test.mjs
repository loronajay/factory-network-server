import assert from "node:assert/strict";
import test from "node:test";
import { buildBoard, isAnswerCorrect, listThemes, getTheme } from "./server/qd-content.mjs";
import {
  QD_PHASES,
  createQDMatchState,
  submitThemeVote,
  allThemeVotesIn,
  resolveThemeVote,
  selectTile,
  autoSelectTile,
  submitAnswer,
  advanceAfterReveal,
  beginPenalty,
  submitPenaltyInput,
  resolvePenalty,
  advanceAfterPenalty,
  advanceTurn,
  serializeQDPublicState,
  serializeQDPrivateState,
} from "./server/qd-match-engine.mjs";

function makeLobby(memberIds) {
  const memberProfiles = new Map(memberIds.map((id) => [id, { displayName: id.toUpperCase() }]));
  return { roomCode: "QDTST", ownerId: memberIds[0], seed: 7, members: new Set(memberIds), memberProfiles };
}

// Drive a fresh match to the BOARD phase with a known theme + active player.
function startedMatch(memberIds = ["p1", "p2"], themeId = "internet-brain") {
  let match = createQDMatchState(makeLobby(memberIds));
  for (const id of memberIds) match = submitThemeVote(match, id, themeId);
  return resolveThemeVote(match);
}

test("content builds a full 4x4 board and validates answers strictly", () => {
  assert.ok(listThemes().length >= 3);
  const board = buildBoard("internet-brain");
  assert.equal(board.categories.length, 4);
  for (const category of board.categories) {
    assert.equal(category.tiles.length, 4);
    assert.deepEqual(category.tiles.map((tile) => tile.points), [100, 200, 300, 400]);
  }
  const mc = getTheme("video-games").categories[0].questions.find((q) => q.format === "multiple-choice");
  assert.equal(isAnswerCorrect(mc, mc.answer), true);
  assert.equal(isAnswerCorrect(mc, "definitely not"), false);
  // Typed answers normalize casing/whitespace/trailing punctuation.
  assert.equal(isAnswerCorrect({ format: "typed-answer", answer: "Canberra", acceptedAnswers: ["Canberra"] }, "  canberra. "), true);
  assert.equal(isAnswerCorrect({ format: "typed-answer", answer: "Canberra", acceptedAnswers: ["Canberra"] }, "canada"), false);
});

test("a new match starts in theme vote with server-owned turn order and match length", () => {
  const match = createQDMatchState(makeLobby(["p1", "p2", "p3", "p4"]));
  assert.equal(match.phase, QD_PHASES.THEME_VOTE);
  assert.deepEqual(match.turnOrder, ["p1", "p2", "p3", "p4"]);
  assert.equal(match.activePlayerId, "p1");
  assert.equal(match.maxTurns, 16); // 4 players
  assert.equal(createQDMatchState(makeLobby(["p1", "p2"])).maxTurns, 12);
});

test("theme voting tallies and the winning theme builds the board", () => {
  let match = createQDMatchState(makeLobby(["p1", "p2"]));
  match = submitThemeVote(match, "p1", "video-games");
  assert.equal(allThemeVotesIn(match), false);
  match = submitThemeVote(match, "p2", "video-games");
  assert.equal(allThemeVotesIn(match), true);
  match = resolveThemeVote(match);
  assert.equal(match.phase, QD_PHASES.BOARD);
  assert.equal(match.selectedThemeId, "video-games");
  assert.equal(match.turn, 1);
  assert.ok(match.board);
});

test("only the active player can open a tile, which starts the question", () => {
  const match = startedMatch();
  assert.equal(selectTile(match, "p2", 0, 0).phase, QD_PHASES.BOARD); // non-active ignored
  const opened = selectTile(match, "p1", 0, 0);
  assert.equal(opened.phase, QD_PHASES.QUESTION);
  assert.equal(opened.board.categories[0].tiles[0].used, true);
  assert.ok(opened.question);
});

test("a correct answer scores the tile value and keeps control", () => {
  let match = selectTile(startedMatch(), "p1", 0, 0); // memes/100: "Doge is a Shiba Inu." -> True
  match = submitAnswer(match, "p1", "True");
  assert.equal(match.phase, QD_PHASES.ANSWER_REVEAL);
  assert.equal(match.answerReveal.correct, true);
  assert.equal(match.players.find((p) => p.id === "p1").score, 100);
  assert.equal(match.keepControl, true);

  match = advanceAfterReveal(match);
  assert.equal(match.phase, QD_PHASES.SCOREBOARD);
  match = advanceTurn(match);
  assert.equal(match.phase, QD_PHASES.BOARD);
  assert.equal(match.activePlayerId, "p1"); // kept control
  assert.equal(match.turn, 2);
});

test("a wrong answer triggers a penalty, then passes the turn", () => {
  let match = selectTile(startedMatch(), "p1", 1, 1); // platforms/200
  const sourceValue = match.question.points;
  match = submitAnswer(match, "p1", "obviously wrong");
  assert.equal(match.answerReveal.correct, false);
  assert.equal(match.keepControl, false);

  match = advanceAfterReveal(match);
  assert.equal(match.phase, QD_PHASES.PENALTY_INTRO);
  match = beginPenalty(match);
  assert.equal(match.phase, QD_PHASES.PENALTY_ACTIVE);
  assert.equal(match.penalty.activePlayerId, "p1");
  assert.equal(match.penalty.maxLoss, Math.round(sourceValue * 1.5));

  // No inputs at all = full loss, capped at sourceValue * 1.5.
  match = resolvePenalty(match);
  assert.equal(match.penalty.pointsLost, match.penalty.maxLoss);
  assert.equal(match.phase, QD_PHASES.PENALTY_RESULTS);

  match = advanceAfterPenalty(match);
  match = advanceTurn(match);
  assert.equal(match.phase, QD_PHASES.BOARD);
  assert.equal(match.activePlayerId, "p2"); // control passed
});

test("surviving a penalty avoids point loss regardless of which module is rolled", () => {
  let match = selectTile(startedMatch(), "p1", 2, 2); // 300-point tile
  match = submitAnswer(match, "p1", "wrong");
  match = beginPenalty(advanceAfterReveal(match));
  // Feed the inputs that clear whichever penalty the engine rolled.
  const state = match.penalty.state;
  if (match.penalty.penaltyId === "pattern-panic") {
    for (const target of state.sequence) match = submitPenaltyInput(match, "p1", target);
  } else {
    for (let i = 0; i < state.required; i += 1) match = submitPenaltyInput(match, "p1", "A");
  }
  match = resolvePenalty(match);
  assert.equal(match.penalty.pointsLost, 0);
});

test("the match ends and names a winner once the turn budget is spent", () => {
  let match = startedMatch(["p1", "p2"]);
  match.maxTurns = 1; // force a quick finish
  match = selectTile(match, "p1", 0, 0);
  match = submitAnswer(match, "p1", "True"); // correct -> p1 leads
  match = advanceTurn(advanceAfterReveal(match));
  assert.equal(match.phase, QD_PHASES.MATCH_END);
  assert.equal(match.winnerPlayerId, "p1");
});

test("board timeout auto-opens a tile so play never stalls", () => {
  const opened = autoSelectTile(startedMatch());
  assert.equal(opened.phase, QD_PHASES.QUESTION);
  assert.ok(opened.question);
});

test("serialization hides answers until reveal and exposes private role flags", () => {
  let match = selectTile(startedMatch(), "p1", 0, 0);
  const publicDuringQuestion = serializeQDPublicState(match);
  assert.equal(publicDuringQuestion.question.prompt.length > 0, true);
  assert.equal("answer" in publicDuringQuestion.question, false);
  assert.equal(publicDuringQuestion.answerReveal, null);

  const activePrivate = serializeQDPrivateState(match, "p1");
  assert.equal(activePrivate.me.canAnswer, true);
  const spectatorPrivate = serializeQDPrivateState(match, "p2");
  assert.equal(spectatorPrivate.me.canAnswer, false);

  match = submitAnswer(match, "p1", "True");
  const revealPublic = serializeQDPublicState(match);
  assert.equal(revealPublic.answerReveal.correct, true);
  assert.equal(revealPublic.answerReveal.correctAnswer, "True");
});
