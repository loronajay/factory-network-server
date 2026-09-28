// A whole Pondside Push match as one steppable thing: countdown, round,
// splash, pause, next round — with nobody pressing "Next".
//
// The browser plays a local match through it and the network server plays an
// online one through the very same file, so the rhythm of a match (how long a
// countdown is, how long the island waits after a splash) is one rule.

import { cpuControls } from "./cpu.js?v=20260928-pet-online";
import { countdownLabel, createRoundCountdown, isCountdownBlocking, stepRoundCountdown } from "./countdown.js?v=20260928-pet-online";
import { createMatch, resetRound, retirePlayer, stepMatch } from "./match.js?v=20260928-pet-online";

/** How long the island holds still after a splash before the next countdown. */
export const ROUND_LINGER_SECONDS = 2.4;
/** How long a finished match stays on screen before the session calls itself over. */
export const MATCH_LINGER_SECONDS = 3;

/**
 * `entrants` is `[{ id, pet, cpu? }]`. `seed` feeds the CPUs' luck. The
 * session's `phase` is `countdown` → `playing` → `round-over` → … → `match-over` → `complete`.
 */
export function createSession({ entrants, seed = 1, winsToMatch } = {}) {
  return {
    seed,
    match: createMatch(entrants, { winsToMatch }),
    countdown: createRoundCountdown(),
    phase: "countdown",
    linger: 0,
    tick: 0,
    // Each CPU seat's scratch memory (cpu.js), keyed by seat id.
    ai: {},
  };
}

function cpuInputs(session) {
  const { match } = session;
  const inputs = {};
  for (const player of match.players) {
    if (player.cpu && !player.eliminated) {
      inputs[player.id] = cpuControls(player, match.players, match.tick, {
        level: player.cpu,
        seed: session.seed,
        islandRadius: match.islandRadius,
        roundSeconds: match.roundTicks / 60,
        memory: (session.ai[player.id] ??= {}),
      });
    }
  }
  return inputs;
}

/** Advance one fixed step. `controls` maps a person's seat id to `{ x, y, bump }`. */
export function stepSession(session, controls = {}, dt = 1 / 60) {
  if (session.phase === "complete") return session;
  session.tick += 1;
  const { match } = session;

  if (session.phase === "countdown") {
    stepRoundCountdown(session.countdown, dt);
    if (isCountdownBlocking(session.countdown)) {
      stepMatch(match, {}, dt);
      return session;
    }
    session.phase = "playing";
  }

  if (session.phase === "playing") {
    if (!session.countdown.complete) stepRoundCountdown(session.countdown, dt);
    stepMatch(match, { ...controls, ...cpuInputs(session) }, dt);
    if (match.phase === "round-over") {
      session.phase = "round-over";
      session.linger = ROUND_LINGER_SECONDS;
    } else if (match.phase === "match-over") {
      session.phase = "match-over";
      session.linger = MATCH_LINGER_SECONDS;
    }
    return session;
  }

  // round-over or match-over: the splash plays out, then the session moves on by itself.
  stepMatch(match, {}, dt);
  session.linger = Math.max(0, session.linger - dt);
  if (session.linger > 0) return session;
  if (session.phase === "match-over") {
    session.phase = "complete";
  } else {
    resetRound(match);
    session.countdown = createRoundCountdown();
    session.phase = "countdown";
  }
  return session;
}

/** A person left: their pet goes in the water and stays there. */
export function retireSeat(session, id) {
  const changed = retirePlayer(session.match, id);
  if (changed && session.phase === "playing" && session.match.phase === "match-over") {
    session.phase = "match-over";
    session.linger = MATCH_LINGER_SECONDS;
  }
  // Leaving between rounds can still end the match: one seat standing is a winner.
  if (changed && (session.phase === "round-over" || session.phase === "countdown")) {
    const standing = session.match.players.filter((player) => !player.left);
    if (standing.length <= 1) {
      session.match.phase = "match-over";
      session.match.matchWinnerId = standing[0]?.id ?? null;
      session.phase = "match-over";
      session.linger = MATCH_LINGER_SECONDS;
    }
  }
  return changed;
}

/** What the banner over the island says right now. */
export function sessionBanner(session) {
  const { match } = session;
  if (session.phase === "countdown" || (session.phase === "playing" && session.countdown.phase === "go")) {
    const label = countdownLabel(session.countdown);
    return label ? `ROUND ${match.round} · ${label}` : "";
  }
  return "";
}

/** The final standing: wins first, then who stayed dry longest in the last round. */
export function matchStandings(session) {
  return [...session.match.players].sort((left, right) => right.wins - left.wins
    || Number(left.eliminated) - Number(right.eliminated)
    || left.id.localeCompare(right.id));
}
