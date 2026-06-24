// Pot of Greed authoritative match engine. All economic state lives here;
// clients only submit intent and receive public/private views.
import { sanitizeDisplayName } from "../../../src/util.mjs";

export const POT_OF_GREED_GAME_ID = "pot-of-greed";
export const POT_OF_GREED_PHASES = Object.freeze({
  HIDDEN_VAULT_ACTION: "hidden_vault_action",
  HIDDEN_DISCUSSION: "hidden_discussion",
  HIDDEN_VOTE: "hidden_vote",
  HIDDEN_RUNOFF_VOTE: "hidden_runoff_vote",
  HIDDEN_VOTE_RESULT: "hidden_vote_result",
  SHOW_VAULT_ACTION: "show_vault_action",
  SHOW_DISCUSSION: "show_discussion",
  SHOW_VOTE: "show_vote",
  SHOW_RUNOFF_VOTE: "show_runoff_vote",
  SHOW_VOTE_RESULT: "show_vote_result",
  FINAL_SETTLEMENT: "final_settlement",
  FINAL_RESULTS: "final_results",
});

export const POT_OF_GREED_CONFIG = Object.freeze({
  minimumPlayers: 4,
  maximumPlayers: 8,
  startingPersonalGold: 20,
  startingVaultGoldPerPlayer: 12,
  investmentPackages: Object.freeze([
    Object.freeze({ cost: 3, returnAmount: 6 }),
    Object.freeze({ cost: 5, returnAmount: 11 }),
    Object.freeze({ cost: 8, returnAmount: 18 }),
  ]),
  theftPackages: Object.freeze([3, 5, 8]),
  correctVoteBonus: 2,
  wrongfulVotePenalty: 2,
  wrongfulAccusationCompensation: 5,
  theftFinePercentage: 0.5,
  vaultActionDuration: 30_000,
  discussionDuration: 90_000,
  voteDuration: 30_000,
  resultDuration: 7_000,
});

function clone(value) {
  return structuredClone(value);
}

function isHiddenPhase(phase) {
  return phase.startsWith("hidden_");
}

function isVaultActionPhase(phase) {
  return phase === POT_OF_GREED_PHASES.HIDDEN_VAULT_ACTION || phase === POT_OF_GREED_PHASES.SHOW_VAULT_ACTION;
}

function isVotePhase(phase) {
  return phase === POT_OF_GREED_PHASES.HIDDEN_VOTE || phase === POT_OF_GREED_PHASES.SHOW_VOTE || phase === POT_OF_GREED_PHASES.HIDDEN_RUNOFF_VOTE || phase === POT_OF_GREED_PHASES.SHOW_RUNOFF_VOTE;
}

function discussionPhaseFor(match) {
  return isHiddenPhase(match.phase) ? POT_OF_GREED_PHASES.HIDDEN_DISCUSSION : POT_OF_GREED_PHASES.SHOW_DISCUSSION;
}

function votePhaseFor(match) {
  return match.cycleType === "hidden" ? POT_OF_GREED_PHASES.HIDDEN_VOTE : POT_OF_GREED_PHASES.SHOW_VOTE;
}

function voteResultPhaseFor(match) {
  return match.cycleType === "hidden" ? POT_OF_GREED_PHASES.HIDDEN_VOTE_RESULT : POT_OF_GREED_PHASES.SHOW_VOTE_RESULT;
}

function playerFor(match, clientId) {
  return match.players.find((player) => player.id === clientId) || null;
}

function activePlayers(match) {
  return match.players.filter((player) => player.status === "active");
}

function connectedPlayers(match) {
  return match.players.filter((player) => player.connected);
}

function investmentPackage(amount) {
  return POT_OF_GREED_CONFIG.investmentPackages.find((item) => item.cost === amount) || null;
}

function actionFor(match, clientId) {
  return match.vaultActions[clientId] || { type: "pass" };
}

function record(match, type, detail = {}) {
  match.history.push({ cycle: match.cycleNumber, type, ...detail });
}

function distributeTheft(available, thefts) {
  const totalRequested = thefts.reduce((total, theft) => total + theft.amount, 0);
  if (totalRequested <= available) return thefts.map((theft) => ({ ...theft, actual: theft.amount }));
  if (totalRequested === 0 || available === 0) return thefts.map((theft) => ({ ...theft, actual: 0 }));

  let remaining = available;
  const payouts = thefts.map((theft) => {
    const actual = Math.floor((available * theft.amount) / totalRequested);
    remaining -= actual;
    return { ...theft, actual };
  });
  for (let index = 0; remaining > 0; index = (index + 1) % payouts.length) {
    payouts[index].actual += 1;
    remaining -= 1;
  }
  return payouts;
}

function actionSummary(match, clientId) {
  const resolved = match.resolvedActions[clientId] || { type: "pass", requested: 0, actualStolen: 0 };
  return { ...resolved };
}

function calculateFinalResults(players, vaultGold) {
  const highestGold = Math.max(...players.map((player) => player.gold));
  let winners = players.filter((player) => player.gold === highestGold);
  if (winners.length > 1) {
    const mostCorrectVotes = Math.max(...winners.map((player) => player.correctVotes));
    winners = winners.filter((player) => player.correctVotes === mostCorrectVotes);
  }
  if (winners.length > 1) {
    const fewestWrongfulVotes = Math.min(...winners.map((player) => player.wrongfulVotes));
    winners = winners.filter((player) => player.wrongfulVotes === fewestWrongfulVotes);
  }
  return {
    winnerIds: winners.map((player) => player.id),
    vaultGold,
    balances: players.map((player) => ({ id: player.id, name: player.name, gold: player.gold, status: player.status })),
  };
}

function assertMatchRoster(lobby) {
  const count = lobby?.members?.size || 0;
  if (count < POT_OF_GREED_CONFIG.minimumPlayers || count > POT_OF_GREED_CONFIG.maximumPlayers) {
    throw new RangeError(`Pot of Greed requires ${POT_OF_GREED_CONFIG.minimumPlayers}-${POT_OF_GREED_CONFIG.maximumPlayers} players.`);
  }
}

export function createPotOfGreedMatchState(lobby, now = Date.now()) {
  assertMatchRoster(lobby);
  const members = [...lobby.members];
  const players = members.map((id, index) => ({
    id,
    clientId: id,
    name: sanitizeDisplayName(lobby?.memberProfiles?.get(id)?.displayName, `Player ${index + 1}`),
    gold: POT_OF_GREED_CONFIG.startingPersonalGold,
    status: "active",
    connected: true,
    pendingInvestments: [],
    correctVotes: 0,
    wrongfulVotes: 0,
  }));
  return {
    gameId: POT_OF_GREED_GAME_ID,
    roomCode: lobby.roomCode,
    hostId: lobby.ownerId,
    cycleNumber: 1,
    cycleType: "hidden",
    phase: POT_OF_GREED_PHASES.HIDDEN_VAULT_ACTION,
    vaultGold: players.length * POT_OF_GREED_CONFIG.startingVaultGoldPerPlayer,
    players,
    vaultActions: {},
    resolvedActions: {},
    votes: {},
    runoffTargets: [],
    audit: null,
    lastVoteResult: null,
    finalResults: null,
    tieBreakSeed: Math.abs(Math.floor(Number(lobby?.seed) || 0)),
    tieBreakCount: 0,
    history: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function submitPotOfGreedVaultAction(match, clientId, intent = {}, now = Date.now()) {
  if (!isVaultActionPhase(match?.phase)) return match;
  const player = playerFor(match, clientId);
  if (!player || player.status !== "active" || !player.connected) return match;
  if (match.vaultActions[clientId]) return match;

  const requestedType = String(intent.type || "pass");
  const amount = Math.floor(Number(intent.amount));
  let action = { type: "pass" };
  if (requestedType === "invest" && match.cycleType === "hidden") {
    const packageChoice = investmentPackage(amount);
    if (packageChoice && player.gold >= packageChoice.cost) action = { type: "invest", amount: packageChoice.cost, returnAmount: packageChoice.returnAmount };
  } else if (requestedType === "steal" && POT_OF_GREED_CONFIG.theftPackages.includes(amount)) {
    action = { type: "steal", amount };
  }

  const next = clone(match);
  next.vaultActions[clientId] = action;
  next.updatedAt = now;
  return next;
}

export function resolvePotOfGreedVaultActions(match, now = Date.now()) {
  if (!isVaultActionPhase(match?.phase)) return match;
  const next = clone(match);
  const vaultBefore = next.vaultGold;
  const actors = activePlayers(next);
  const theftRequests = [];
  next.resolvedActions = {};

  for (const player of actors) {
    const action = actionFor(next, player.id);
    if (action.type === "invest") {
      const packageChoice = investmentPackage(action.amount);
      if (packageChoice && player.gold >= packageChoice.cost && next.cycleType === "hidden") {
        player.gold -= packageChoice.cost;
        next.vaultGold += packageChoice.cost;
        player.pendingInvestments.push({ cost: packageChoice.cost, returnAmount: packageChoice.returnAmount, createdCycle: next.cycleNumber });
        next.resolvedActions[player.id] = { type: "invest", requested: packageChoice.cost, actualStolen: 0 };
        record(next, "investment", { playerId: player.id, cost: packageChoice.cost, returnAmount: packageChoice.returnAmount });
        continue;
      }
    }
    if (action.type === "steal") theftRequests.push({ playerId: player.id, amount: action.amount });
    next.resolvedActions[player.id] = { type: action.type === "steal" ? "steal" : "pass", requested: action.amount || 0, actualStolen: 0 };
  }

  const payouts = distributeTheft(next.vaultGold, theftRequests);
  for (const payout of payouts) {
    const player = playerFor(next, payout.playerId);
    player.gold += payout.actual;
    next.vaultGold -= payout.actual;
    next.resolvedActions[payout.playerId] = { type: "steal", requested: payout.amount, actualStolen: payout.actual };
    record(next, "theft", { playerId: payout.playerId, requested: payout.amount, actual: payout.actual });
  }

  next.audit = { vaultBefore, vaultAfter: next.vaultGold, netChange: next.vaultGold - vaultBefore };
  record(next, "vault_audit", { ...next.audit });
  next.phase = discussionPhaseFor(next);
  next.updatedAt = now;
  return next;
}

export function beginPotOfGreedVote(match, now = Date.now()) {
  if (match?.phase !== POT_OF_GREED_PHASES.HIDDEN_DISCUSSION && match?.phase !== POT_OF_GREED_PHASES.SHOW_DISCUSSION) return match;
  const next = clone(match);
  next.phase = votePhaseFor(next);
  next.votes = {};
  next.runoffTargets = [];
  next.updatedAt = now;
  return next;
}

export function submitPotOfGreedVote(match, clientId, targetId, now = Date.now()) {
  if (!isVotePhase(match?.phase)) return match;
  const voter = playerFor(match, clientId);
  const target = playerFor(match, targetId);
  if (!voter || !voter.connected || !target || target.status !== "active" || voter.id === target.id || match.votes[clientId]) return match;
  if (match.runoffTargets.length && !match.runoffTargets.includes(targetId)) return match;

  const next = clone(match);
  next.votes[clientId] = targetId;
  next.updatedAt = now;
  return next;
}

function tallyVotes(match) {
  const tally = Object.fromEntries(activePlayers(match).map((player) => [player.id, 0]));
  for (const targetId of Object.values(match.votes)) if (targetId in tally) tally[targetId] += 1;
  return tally;
}

export function resolvePotOfGreedVote(match, now = Date.now()) {
  if (!isVotePhase(match?.phase)) return match;
  const next = clone(match);
  const tally = tallyVotes(next);
  const highestVotes = Math.max(0, ...Object.values(tally));
  const leaders = Object.keys(tally).filter((id) => tally[id] === highestVotes);
  if (leaders.length !== 1) {
    if (!next.runoffTargets.length) {
      next.runoffTargets = leaders;
      next.votes = {};
      next.phase = next.cycleType === "hidden" ? POT_OF_GREED_PHASES.HIDDEN_RUNOFF_VOTE : POT_OF_GREED_PHASES.SHOW_RUNOFF_VOTE;
      next.updatedAt = now;
      return next;
    }
    const activeVoteCounts = Object.fromEntries(leaders.map((id) => [id, 0]));
    for (const [voterId, targetId] of Object.entries(next.votes)) if (playerFor(next, voterId)?.status === "active" && targetId in activeVoteCounts) activeVoteCounts[targetId] += 1;
    const activeHighest = Math.max(...Object.values(activeVoteCounts));
    const activeLeaders = leaders.filter((id) => activeVoteCounts[id] === activeHighest);
    const tiedCandidates = activeLeaders.length ? activeLeaders : leaders;
    const index = (next.tieBreakSeed + next.tieBreakCount) % tiedCandidates.length;
    next.tieBreakCount += 1;
    leaders.splice(0, leaders.length, tiedCandidates[index]);
  }

  const selectedId = leaders[0];
  const selected = playerFor(next, selectedId);
  const selectedAction = actionSummary(next, selectedId);
  const correct = selectedAction.type === "steal";
  const votersForSelected = Object.entries(next.votes).filter(([, targetId]) => targetId === selectedId).map(([voterId]) => playerFor(next, voterId)).filter(Boolean);
  let fine = 0;

  if (correct) {
    fine = Math.min(selected.gold, selectedAction.actualStolen, Math.ceil(selectedAction.actualStolen * POT_OF_GREED_CONFIG.theftFinePercentage));
    selected.gold -= fine;
    next.vaultGold += fine;
    for (const voter of votersForSelected) {
      voter.gold += POT_OF_GREED_CONFIG.correctVoteBonus;
      voter.correctVotes += 1;
    }
  } else {
    for (const voter of votersForSelected) {
      voter.gold = Math.max(0, voter.gold - POT_OF_GREED_CONFIG.wrongfulVotePenalty);
      voter.wrongfulVotes += 1;
    }
    selected.gold += POT_OF_GREED_CONFIG.wrongfulAccusationCompensation;
  }
  selected.status = "jury";
  next.lastVoteResult = { tally, selectedId, selectedAction, correct, fine, randomTieBreak: !!match.runoffTargets.length && leaders.length === 1 && Object.values(tally).filter((count) => count === highestVotes).length > 1 };
  record(next, "vote_result", { selectedId, selectedAction, correct, fine, tally });
  next.phase = voteResultPhaseFor(next);
  next.updatedAt = now;
  return next;
}

export function advancePotOfGreedCycle(match, now = Date.now()) {
  if (match?.phase !== POT_OF_GREED_PHASES.HIDDEN_VOTE_RESULT && match?.phase !== POT_OF_GREED_PHASES.SHOW_VOTE_RESULT) return match;
  const next = clone(match);
  if (activePlayers(next).length === 0) {
    for (const player of next.players) {
      for (const investment of player.pendingInvestments) {
        player.gold += investment.returnAmount;
        record(next, "investment_return", { playerId: player.id, amount: investment.returnAmount, finalSettlement: true });
      }
      player.pendingInvestments = [];
    }
    next.finalResults = calculateFinalResults(next.players, next.vaultGold);
    next.phase = POT_OF_GREED_PHASES.FINAL_RESULTS;
    next.updatedAt = now;
    return next;
  }

  next.cycleNumber += 1;
  next.cycleType = next.cycleType === "hidden" ? "show" : "hidden";
  if (next.cycleType === "show") {
    for (const player of next.players) {
      for (const investment of player.pendingInvestments) {
        player.gold += investment.returnAmount;
        record(next, "investment_return", { playerId: player.id, amount: investment.returnAmount });
      }
      player.pendingInvestments = [];
    }
    next.phase = POT_OF_GREED_PHASES.SHOW_VAULT_ACTION;
  } else {
    next.phase = POT_OF_GREED_PHASES.HIDDEN_VAULT_ACTION;
  }
  next.vaultActions = {};
  next.resolvedActions = {};
  next.votes = {};
  next.runoffTargets = [];
  next.audit = null;
  next.updatedAt = now;
  return next;
}

export function applyPotOfGreedConnection(match, clientId, connected, now = Date.now()) {
  const player = playerFor(match, clientId);
  if (!player || player.connected === !!connected) return match;
  const next = clone(match);
  playerFor(next, clientId).connected = !!connected;
  next.updatedAt = now;
  return next;
}

export function serializePotOfGreedPublicState(match) {
  return {
    gameId: match.gameId,
    roomCode: match.roomCode,
    cycleNumber: match.cycleNumber,
    cycleType: match.cycleType,
    phase: match.phase,
    vaultGold: match.vaultGold,
    audit: match.audit ? { ...match.audit } : null,
    players: match.players.map(({ id, name, status, connected, gold }) => ({ id, name, status, connected, ...(match.cycleType === "show" || match.phase === POT_OF_GREED_PHASES.FINAL_RESULTS ? { gold } : {}) })),
    voteProgress: { submitted: Object.keys(match.votes).length, eligible: connectedPlayers(match).length },
    lastVoteResult: match.lastVoteResult ? clone(match.lastVoteResult) : null,
    finalResults: match.finalResults ? clone(match.finalResults) : null,
  };
}

export function serializePotOfGreedPrivateState(match, clientId) {
  const player = playerFor(match, clientId);
  if (!player) return null;
  return {
    ...serializePotOfGreedPublicState(match),
    me: {
      id: player.id,
      gold: player.gold,
      status: player.status,
      pendingInvestments: clone(player.pendingInvestments),
      submittedAction: !!match.vaultActions[player.id],
      submittedVote: !!match.votes[player.id],
    },
  };
}
