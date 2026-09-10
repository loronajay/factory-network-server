import { HOTSEAT_ROUNDS, HOTSEAT_SHOTS_PER_TURN } from "./hotseat-session.js";
import { createPlaySession } from "./play-session.js";

export const ONLINE_MATCH_PHASE = Object.freeze({
  READY: "ready",
  PLAYING: "playing",
  TURN_OVER: "turn-over",
  MATCH_OVER: "match-over",
});

export function normalizeOnlinePlayers(players = []) {
  return players.slice(0, 4).map((player, index) => {
    const clientId = String(player?.clientId || player?.id || `player-${index + 1}`);
    return {
      id: clientId,
      clientId,
      name: String(player?.name || player?.displayName || `Player ${index + 1}`).slice(0, 18),
    };
  });
}

export function createOnlineTurnSession() {
  return createPlaySession({ shotsPerRun: HOTSEAT_SHOTS_PER_TURN });
}

export function createOnlineMatchSession(players = []) {
  const normalizedPlayers = normalizeOnlinePlayers(players);
  const scores = Object.fromEntries(normalizedPlayers.map((player) => [player.clientId, 0]));
  return {
    phase: ONLINE_MATCH_PHASE.READY,
    round: 1,
    activeIndex: 0,
    players: normalizedPlayers,
    scores,
    winnerClientId: null,
    turnId: 1,
    syncSeq: 0,
  };
}

export function getOnlineActivePlayer(match) {
  return match?.players?.[match.activeIndex] || null;
}

export function startOnlineMatchTurn(match) {
  if (match.phase !== ONLINE_MATCH_PHASE.READY && match.phase !== ONLINE_MATCH_PHASE.TURN_OVER) return match;
  return {
    ...match,
    phase: ONLINE_MATCH_PHASE.PLAYING,
  };
}

export function addOnlineMatchScore(match, amount) {
  const active = getOnlineActivePlayer(match);
  if (!active) return match;
  const safeAmount = Math.max(0, Number(amount) || 0);
  return {
    ...match,
    scores: {
      ...match.scores,
      [active.clientId]: (match.scores[active.clientId] || 0) + safeAmount,
    },
  };
}

export function finishOnlineMatchTurn(match) {
  if (match.phase !== ONLINE_MATCH_PHASE.PLAYING) return match;
  const playerCount = Math.max(1, match.players.length);
  const isLastPlayer = match.activeIndex >= playerCount - 1;
  const isLastRound = match.round >= HOTSEAT_ROUNDS;

  if (isLastPlayer && isLastRound) {
    return {
      ...match,
      phase: ONLINE_MATCH_PHASE.MATCH_OVER,
      winnerClientId: resolveOnlineWinner(match.scores),
    };
  }

  return {
    ...match,
    phase: ONLINE_MATCH_PHASE.TURN_OVER,
    activeIndex: isLastPlayer ? 0 : match.activeIndex + 1,
    round: isLastPlayer ? match.round + 1 : match.round,
    turnId: match.turnId + 1,
  };
}

export function resolveOnlineWinner(scores = {}) {
  let winner = null;
  let winnerScore = -Infinity;
  let tied = false;
  for (const [clientId, scoreValue] of Object.entries(scores)) {
    const score = Number(scoreValue) || 0;
    if (score > winnerScore) {
      winner = clientId;
      winnerScore = score;
      tied = false;
    } else if (score === winnerScore) {
      tied = true;
    }
  }
  return tied ? "tie" : winner;
}
