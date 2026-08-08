// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/sim/match.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

// Head-to-head match rules — pure, and deliberately **import-free**.
//
// A match is a best-of-N of rounds; a round is one run down the strip, which may
// have to be re-run because somebody jumped the light. This module owns both
// layers and nothing else: it never sees a car, a track or a socket, only who
// fouled, who finished and when.
//
// **Zero imports is a design constraint, not an accident.** The server has to
// adjudicate the match, and the two repos are independent — shared logic is
// mirrored as a `.mjs` copy rather than imported across the boundary (the
// circuit-siege pattern). Keeping this file free of imports is what makes that
// port a rename instead of a rewrite. Do not reach for `constants.js` here.
//
// Two rules decide almost everything:
//
//   **A red light ends the round at green.** The race does not run. On a drag
//   strip the red bulb lights before the cars have left, and the run is over
//   before it started — so the tree is adjudicated the moment it goes green and
//   the round either restarts or is forfeit. This is also why fouls are
//   collected across the whole countdown rather than resolved the instant the
//   first one happens: both drivers can jump the same tree, and the rule for
//   that case (below) needs to know about both of them.
//
//   **The grace fault resets every round.** Each round is its own contest: two
//   red lights *in the same round* forfeit it, and the counter zeroes when the
//   next round starts. A driver who reds once a round all match is never
//   escalated against — the cost of a red light is the round it happened in,
//   not a debt carried into the next one.

export const MATCH_LIVE = "live";
export const MATCH_DECIDED = "decided";

/** What just happened, for the screen to narrate. Never drives a rule. */
export const EVENT_NONE = "none";
export const EVENT_ROUND_RESTART = "round-restart";
export const EVENT_ROUND_WON = "round-won";
export const EVENT_MATCH_WON = "match-won";

/** Why a round ended. */
export const REASON_RED_LIGHT = "red-light";
export const REASON_TIME = "time";
export const REASON_DISCONNECT = "disconnect";

/** The match lengths a lobby may offer. Best-of-N, so always odd. */
export const BEST_OF_OPTIONS = [1, 3, 5];
export const DEFAULT_BEST_OF = 3;

/**
 * `bestOf` is the number of rounds available; `roundsToWin` is the majority that
 * actually ends it, and is derived rather than passed so the two cannot
 * disagree. A best-of-3 is won with 2.
 */
export function createMatch({ playerIds, bestOf = DEFAULT_BEST_OF, graceFaults = 1 } = {}) {
  if (!Array.isArray(playerIds) || playerIds.length !== 2) {
    throw new Error("A head-to-head match needs exactly two players");
  }
  if (playerIds[0] === playerIds[1]) {
    throw new Error("A match needs two distinct players");
  }
  if (!BEST_OF_OPTIONS.includes(bestOf)) {
    throw new Error(`bestOf must be one of ${BEST_OF_OPTIONS.join(", ")}`);
  }

  return {
    playerIds: [...playerIds],
    bestOf,
    roundsToWin: Math.ceil(bestOf / 2),
    graceFaults,

    wins: { [playerIds[0]]: 0, [playerIds[1]]: 0 },
    round: newRound(1),
    history: [],

    status: MATCH_LIVE,
    winnerId: null,
    loserId: null,
    draw: false,
    lastEvent: { kind: EVENT_NONE },
  };
}

/** A fresh round. The fault counters start clean — that is the per-round rule. */
function newRound(number) {
  return { number, attempt: 1, faults: {} };
}

export function faultsFor(match, playerId) {
  return match.round.faults[playerId] ?? 0;
}

export function winsFor(match, playerId) {
  return match.wins[playerId] ?? 0;
}

export function isDecided(match) {
  return match.status === MATCH_DECIDED;
}

export function opponentOf(match, playerId) {
  return match.playerIds.find((id) => id !== playerId) ?? null;
}

/**
 * Adjudicates the tree, at green.
 *
 * `offenders` is every player who touched the throttle before the green, each as
 * `{ playerId, jumpedBeforeGreen }` — seconds still on the tree when they left,
 * so a *larger* value means they went earlier.
 *
 * An empty list is a clean start and changes nothing, so a caller can pipe every
 * tree through here unconditionally and let the result say whether the race runs.
 */
export function recordFalseStarts(match, offenders) {
  if (isDecided(match) || !offenders || offenders.length === 0) {
    return { ...match, lastEvent: { kind: EVENT_NONE } };
  }
  for (const offender of offenders) {
    if (!match.playerIds.includes(offender.playerId)) {
      throw new Error(`"${offender.playerId}" is not in this match`);
    }
  }

  const faults = { ...match.round.faults };
  for (const offender of offenders) {
    faults[offender.playerId] = (faults[offender.playerId] ?? 0) + 1;
  }

  // A driver is out of the round once their fault count for it exceeds the
  // allowance. Faults are per round, so this is the only counter consulted.
  const eliminated = offenders.filter((offender) => faults[offender.playerId] > match.graceFaults);
  const round = { ...match.round, faults };

  if (eliminated.length === 0) {
    return restartRound({ ...match, round });
  }
  if (eliminated.length === 1) {
    return awardRound({ ...match, round }, opponentOf(match, eliminated[0].playerId), REASON_RED_LIGHT);
  }

  // Both out on the same tree: the car that left first takes the red light,
  // which is the drag-strip convention.
  const earliest = Math.max(...eliminated.map((offender) => offender.jumpedBeforeGreen));
  const first = eliminated.filter((offender) => offender.jumpedBeforeGreen === earliest);
  if (first.length > 1) {
    // A dead-heat foul: nobody can be said to have gone first, so neither takes
    // the round. It re-runs with the faults intact, which means the very next
    // offence by either driver settles it.
    return restartRound({ ...match, round });
  }
  return awardRound({ ...match, round }, opponentOf(match, first[0].playerId), REASON_RED_LIGHT);
}

/**
 * Decides a round that actually ran. `results` is one entry per player as
 * `{ playerId, finishTime, complete }`; `finishTime` is the authoritative time
 * from the server's own replay, never a number the client reported about itself.
 *
 * A driver who did not cross the line loses to one who did. Neither crossing, or
 * both crossing on exactly the same number, re-runs the round rather than
 * inventing a winner.
 */
export function recordFinish(match, results) {
  if (isDecided(match)) {
    return { ...match, lastEvent: { kind: EVENT_NONE } };
  }
  for (const result of results ?? []) {
    if (!match.playerIds.includes(result.playerId)) {
      throw new Error(`"${result.playerId}" is not in this match`);
    }
  }

  const finished = (results ?? []).filter((result) => result.complete && result.finishTime !== null);
  if (finished.length === 0) {
    return restartRound(match);
  }
  if (finished.length === 1) {
    return awardRound(match, finished[0].playerId, REASON_TIME);
  }

  const [a, b] = finished;
  if (a.finishTime === b.finishTime) {
    return restartRound(match); // a dead heat re-runs
  }
  return awardRound(match, a.finishTime < b.finishTime ? a.playerId : b.playerId, REASON_TIME);
}

/**
 * A player who left. The opponent takes the whole match rather than the round —
 * there is nobody left to run the remaining rounds against.
 */
export function recordDisconnect(match, playerId) {
  if (isDecided(match)) {
    return { ...match, lastEvent: { kind: EVENT_NONE } };
  }
  if (!match.playerIds.includes(playerId)) {
    throw new Error(`"${playerId}" is not in this match`);
  }
  const winnerId = opponentOf(match, playerId);
  return {
    ...match,
    status: MATCH_DECIDED,
    winnerId,
    loserId: playerId,
    draw: false,
    lastEvent: { kind: EVENT_MATCH_WON, winnerId, loserId: playerId, reason: REASON_DISCONNECT },
  };
}

/**
 * Re-runs the current round. The attempt counter climbs but the round number
 * does not, and the faults stay — they belong to the round, not to the attempt.
 */
function restartRound(match) {
  const round = { ...match.round, attempt: match.round.attempt + 1 };
  return {
    ...match,
    round,
    lastEvent: { kind: EVENT_ROUND_RESTART, number: round.number, attempt: round.attempt },
  };
}

/**
 * Hands the round to `winnerId` and moves the match on.
 *
 * The next round is built by `newRound`, which is where the per-round fault
 * reset actually happens — there is one place a round begins, so there is one
 * place the counters can be cleared.
 */
function awardRound(match, winnerId, reason) {
  const loserId = opponentOf(match, winnerId);
  const wins = { ...match.wins, [winnerId]: (match.wins[winnerId] ?? 0) + 1 };
  const history = [
    ...match.history,
    { number: match.round.number, attempts: match.round.attempt, winnerId, loserId, reason },
  ];

  if (wins[winnerId] >= match.roundsToWin) {
    return {
      ...match,
      wins,
      history,
      status: MATCH_DECIDED,
      winnerId,
      loserId,
      draw: false,
      lastEvent: { kind: EVENT_MATCH_WON, winnerId, loserId, reason },
    };
  }

  return {
    ...match,
    wins,
    history,
    round: newRound(match.round.number + 1),
    lastEvent: { kind: EVENT_ROUND_WON, winnerId, loserId, reason, number: match.round.number },
  };
}

/**
 * The scoreboard, shaped for a screen: one row per player in match order, plus
 * how many rounds are still worth playing for. Renderers read this rather than
 * reaching into `wins` and re-deriving the same arithmetic in two places.
 */
export function matchScore(match) {
  return {
    bestOf: match.bestOf,
    roundsToWin: match.roundsToWin,
    roundNumber: match.round.number,
    attempt: match.round.attempt,
    decided: isDecided(match),
    winnerId: match.winnerId,
    players: match.playerIds.map((playerId) => ({
      playerId,
      wins: winsFor(match, playerId),
      faults: faultsFor(match, playerId),
      // One more red light this round and it is gone.
      onTheEdge: faultsFor(match, playerId) >= match.graceFaults,
    })),
  };
}
