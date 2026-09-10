import { createPlaySession } from "./play-session.js";

export const HOTSEAT_ROUNDS = 3;
export const HOTSEAT_SHOTS_PER_TURN = 5;

export const HOTSEAT_PHASE = Object.freeze({
  READY: "ready",
  PLAYING: "playing",
  TURN_OVER: "turn-over",
  MATCH_OVER: "match-over",
});

export const HOTSEAT_PLAYERS = Object.freeze(["p1", "p2"]);

export function createHotseatTurnSession() {
  return createPlaySession({ shotsPerRun: HOTSEAT_SHOTS_PER_TURN });
}

export function createHotseatSession() {
  return {
    phase: HOTSEAT_PHASE.READY,
    round: 1,
    currentPlayer: "p1",
    scores: { p1: 0, p2: 0 },
    winner: null,
  };
}

export function startHotseatTurn(session) {
  if (session.phase !== HOTSEAT_PHASE.READY && session.phase !== HOTSEAT_PHASE.TURN_OVER) return session;
  return {
    ...session,
    phase: HOTSEAT_PHASE.PLAYING,
  };
}

export function addHotseatScore(session, amount) {
  const safeAmount = Math.max(0, Number(amount) || 0);
  return {
    ...session,
    scores: {
      ...session.scores,
      [session.currentPlayer]: session.scores[session.currentPlayer] + safeAmount,
    },
  };
}

export function finishHotseatTurn(session) {
  if (session.phase !== HOTSEAT_PHASE.PLAYING) return session;

  if (session.currentPlayer === "p1") {
    return {
      ...session,
      phase: HOTSEAT_PHASE.TURN_OVER,
      currentPlayer: "p2",
    };
  }

  if (session.round < HOTSEAT_ROUNDS) {
    return {
      ...session,
      phase: HOTSEAT_PHASE.TURN_OVER,
      currentPlayer: "p1",
      round: session.round + 1,
    };
  }

  return {
    ...session,
    phase: HOTSEAT_PHASE.MATCH_OVER,
    winner: resolveHotseatWinner(session.scores),
  };
}

export function advanceHotseatReady(session) {
  if (session.phase !== HOTSEAT_PHASE.TURN_OVER && session.phase !== HOTSEAT_PHASE.READY) return session;
  return {
    ...session,
    phase: HOTSEAT_PHASE.READY,
  };
}

export function resolveHotseatWinner(scores) {
  if (scores.p1 > scores.p2) return "p1";
  if (scores.p2 > scores.p1) return "p2";
  return "tie";
}
