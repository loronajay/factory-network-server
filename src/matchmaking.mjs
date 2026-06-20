// Side-aware matchmaking: queue keys, opponent claiming, queue-count fan-out,
// and the mirrored match_ready payload builder. The pure functions
// (normalizeMatchSide, getMatchQueueKey, claimQueuedOpponent, enqueueMatchClient,
// getQueueCountsForGame, buildMatchReadyMessages, ...) take their collections as
// arguments so they can be unit tested without touching shared state.
import crypto from "crypto";
import { MATCH_READY_DELAY_MS, matchQueues, clientSides, clients, clientQueueWatch } from "./state.mjs";
import { sendToClient } from "./transport.mjs";

const SIDE_PAIRS = [
  ["boy", "girl"],
  ["alpha", "beta"],
  ["p1", "p2"],
];

export function normalizeMatchSide(side) {
  if (!side || typeof side !== "string") return null;
  const s = side.trim();
  return SIDE_PAIRS.some(([a, b]) => s === a || s === b) ? s : null;
}

export function getMatchQueueKey(gameId, side) {
  return side ? `${gameId}:${side}` : gameId;
}

export function getOpponentMatchSide(side) {
  for (const [a, b] of SIDE_PAIRS) {
    if (side === a) return b;
    if (side === b) return a;
  }
  return null;
}

export function getGameIdFromQueueKey(queueKey) {
  return String(queueKey || "").split(":")[0];
}

export function getQueueCountsForGame(queues, gameId) {
  const counts = {};
  for (const [a, b] of SIDE_PAIRS) {
    counts[a] = (queues.get(getMatchQueueKey(gameId, a)) || []).length;
    counts[b] = (queues.get(getMatchQueueKey(gameId, b)) || []).length;
  }
  return counts;
}

export function shouldReceiveQueueStatus(watchedGames, clientId, gameId) {
  return watchedGames.get(clientId) === gameId;
}

export function sendQueueStatus(clientId, gameId) {
  const counts = getQueueCountsForGame(matchQueues, gameId);
  // Flatten all side counts as top-level keys (e.g. boyWaiting, girlWaiting, p1Waiting, p2Waiting)
  const sideKeys = {};
  for (const [key, val] of Object.entries(counts)) {
    sideKeys[`${key}Waiting`] = val;
  }
  sendToClient(clientId, {
    event: "queue_status",
    gameId,
    queueCounts: counts,
    ...sideKeys,
  });
}

export function broadcastQueueStatus(gameId) {
  if (!gameId) return;

  for (const clientId of clients.keys()) {
    if (!shouldReceiveQueueStatus(clientQueueWatch, clientId, gameId)) continue;
    sendQueueStatus(clientId, gameId);
  }
}

export function claimQueuedOpponent(queues, gameId, side) {
  const opponentSide = getOpponentMatchSide(side);
  const queueKey = getMatchQueueKey(gameId, opponentSide);
  const queue = queues.get(queueKey) || [];
  if (queue.length === 0) return null;

  const opponentId = queue.shift();
  if (queue.length === 0) queues.delete(queueKey);
  return opponentId;
}

export function enqueueMatchClient(queues, gameId, side, clientId) {
  const queueKey = getMatchQueueKey(gameId, side);
  const queue = queues.get(queueKey) || [];
  queue.push(clientId);
  queues.set(queueKey, queue);
}

export function makeMatchSeed() {
  return crypto.randomBytes(4).readUInt32BE(0);
}

// Generic side assignment. The per-game strategy (a plain descriptor from the
// registry) decides the shape; this function never names a game.
//   "symmetric-balanced" — server picks whichever of two sides has the shorter
//                          queue, so any two searchers form a complementary pair.
//   anything else        — honor the client's requested side (legacy/side-pair).
export function assignSideForStrategy(strategy, gameId, requestedSide, queues) {
  if (strategy?.strategy === "symmetric-balanced" && Array.isArray(strategy.sides) && strategy.sides.length === 2) {
    const [a, b] = strategy.sides;
    const aLen = (queues.get(getMatchQueueKey(gameId, a)) || []).length;
    const bLen = (queues.get(getMatchQueueKey(gameId, b)) || []).length;
    return aLen > bLen ? b : a;
  }
  return requestedSide;
}

// `matchSettings` is the deterministic, server-owned config for the game (or null).
// It is produced by the game's own definition, not by this generic module.
export function buildMatchReadyMessages(clientAId, sideA, clientBId, sideB, serverNow = Date.now(), startDelayMs = MATCH_READY_DELAY_MS, seed = makeMatchSeed(), matchSettings = null) {
  const normalizedA = normalizeMatchSide(sideA);
  const normalizedB = normalizeMatchSide(sideB);
  if (!normalizedA || !normalizedB || normalizedA === normalizedB) return null;

  const startAt = serverNow + startDelayMs;
  const settingsPayload = matchSettings ? { matchSettings } : {};
  return [
    {
      clientId: clientAId,
      payload: { event: "match_ready", seed, serverNow, startAt, remoteSide: normalizedB, ...settingsPayload }
    },
    {
      clientId: clientBId,
      payload: { event: "match_ready", seed, serverNow, startAt, remoteSide: normalizedA, ...settingsPayload }
    },
  ];
}

export function setClientSide(clientId, side) {
  const normalized = normalizeMatchSide(side);
  if (normalized) clientSides.set(clientId, normalized);
  else clientSides.delete(clientId);
  return normalized;
}

export function leaveQueue(clientId) {
  for (const [queueKey, queue] of matchQueues) {
    const i = queue.indexOf(clientId);
    if (i !== -1) {
      queue.splice(i, 1);
      if (queue.length === 0) matchQueues.delete(queueKey);
      return queueKey;
    }
  }
  return null;
}
