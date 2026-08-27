// Pure match rules for HORSE. Where the bin stands is `sim/bin-placement.js`;
// whether a shot went in is the physics. This file only decides what an outcome
// MEANS — who shoots next, who picks up a letter, and when the word is spelled.
//
// THE SETTER SHOOTS FIRST, AND THAT IS THE WHOLE BALANCE OF THE MODE. A player
// placing a bin can put it anywhere the room allows, including places nothing
// can reach — and no bounds check has to care, because they have to make the
// shot themselves before it becomes a shot anyone else owes. Greed is punished
// by the rules rather than by a validator, which is why `bin-placement.js`
// deliberately does not test a placement for reachability.
//
// THE SETTER KEEPS CONTROL UNTIL THEY MISS. Matching a standing shot buys you
// nothing but safety: the setter sets again, whether the matcher made it or
// took a letter for it. Control changes hands in exactly one place — a setter
// who misses their OWN setup. So a player on a hot hand keeps dictating, and
// the only way out from under it is to wait for them to miss a shot of their
// own making, which is also the one thing they cannot farm.

export const DEFAULT_WORD = "HORSE";

/**
 * The fixed room and the default turn ball, shared with online adjudication.
 *
 * Stated here rather than in the root that draws it, because online HORSE is
 * adjudicated by a mirrored copy of this sim on `factory-network-server` — and a
 * default named in one root and re-typed in a server module is exactly the kind
 * of pair that drifts silently. Players may replace it from the on-court picker
 * before each shot; this is the safe fallback for old or malformed intents.
 */
export const HORSE_FIXED_SETUP = Object.freeze({
  locationId: "warehouse",
  ballId: "basketball",
});
export const MAX_WORD_LENGTH = 10;

// Setting a new shot, versus owing one that already stands.
export const PHASE_SET = "set";
export const PHASE_MATCH = "match";

/**
 * A word the mode can actually spell out one letter at a time.
 *
 * Letters only, and upper-cased: the HUD prints the earned letters against the
 * unearned ones, and mixed case would read as two different alphabets. Anything
 * that survives to zero length falls back rather than producing a match that is
 * already over before the first shot.
 */
export function normalizeWord(value) {
  const clean = String(value ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, MAX_WORD_LENGTH);
  return clean || DEFAULT_WORD;
}

export function horseModeId(value) {
  return value === "local" || value === "online" ? value : "cpu";
}

export function createHorseMatch({
  mode = "cpu",
  word = DEFAULT_WORD,
  names = [],
  startingPlayer = 0,
} = {}) {
  const matchMode = horseModeId(mode);
  const first = startingPlayer === 1 ? 1 : 0;
  return {
    mode: matchMode,
    word: normalizeWord(word),
    players: [0, 1].map((index) => ({
      name: names[index] || defaultName(matchMode, index),
      letters: 0,
    })),
    // Whose shot it is now.
    turn: first,
    // What that shot is FOR: setting a new one, or matching the standing one.
    phase: PHASE_SET,
    // Who owns the standing shot, and what it is. Null until someone sets one.
    setter: first,
    standingShot: null,
    status: "playing",
    winner: null,
    // What the last resolved shot did, for the HUD to narrate.
    lastOutcome: null,
    shots: 0,
  };
}

function defaultName(mode, index) {
  if (mode === "local") return `Player ${index + 1}`;
  if (mode === "online") return index === 0 ? "You" : "Opponent";
  return index === 0 ? "You" : "CPU";
}

/** The word as earned/unearned letters, for the HUD. */
export function letterState(match, playerIndex) {
  const earned = match.players[playerIndex]?.letters ?? 0;
  return [...match.word].map((letter, index) => ({ letter, earned: index < earned }));
}

/**
 * Is the shot on offer this player's to take?
 *
 * `seat` is which of the two rows in `players` belongs to the hand holding the
 * device, and it only ever moves off zero online — the host is seat 0 and the
 * guest seat 1, decided by the lobby's member order. Hotseat hands the court to
 * whoever is up, so both seats are human there.
 */
export function isHumanControlledTurn(match, seat = 0) {
  if (match?.status !== "playing") return false;
  if (match.mode === "local") return true;
  return match.turn === (seat === 1 ? 1 : 0);
}

export function playerLabel(match, index = match?.turn) {
  return match?.players?.[index]?.name || `Player ${index + 1}`;
}

/** Is the current shooter free to place a bin, or are they owed a standing one? */
export function canPlaceBin(match) {
  return match?.status === "playing" && match.phase === PHASE_SET;
}

/**
 * The setup the current shooter is shooting at.
 *
 * In `set` the shooter is building one, so this is whatever they have currently
 * arranged and the caller owns it. In `match` it is the standing shot, and the
 * matcher does not get a vote — matching the bin exactly, motion and all, is
 * what "the same shot" means. What they do NOT copy is the pull: you match the
 * target, not the hand.
 */
export function shotSetupFor(match, workingSetup) {
  return match?.phase === PHASE_MATCH ? match.standingShot : workingSetup;
}

/**
 * Resolve a completed shot.
 *
 * @param setup the bin setup the shot was taken against — recorded as the
 *              standing shot when a setter makes one.
 * @returns a description of what changed, for the HUD; the match is mutated.
 */
export function resolveHorseShot(match, made, setup = null) {
  if (!match || match.status !== "playing") {
    return { accepted: false };
  }

  const shooter = match.turn;
  const other = shooter === 0 ? 1 : 0;
  match.shots += 1;

  if (match.phase === PHASE_SET) {
    if (made) {
      // The shot is now owed. The matcher shoots next, at exactly this bin.
      match.setter = shooter;
      match.standingShot = setup;
      match.phase = PHASE_MATCH;
      match.turn = other;
      match.lastOutcome = { shooter, made: true, letter: false, kind: "set" };
    } else {
      // A setter who misses sets nothing and loses nothing. Control simply
      // passes — which is what keeps a player from farming letters by lobbing
      // impossible shots and shrugging.
      match.standingShot = null;
      match.phase = PHASE_SET;
      match.turn = other;
      match.lastOutcome = { shooter, made: false, letter: false, kind: "set-missed" };
    }
    return { accepted: true, ...match.lastOutcome, status: match.status };
  }

  // Matching a standing shot.
  if (made) {
    // Matched: no letter, and NOTHING ELSE CHANGES HANDS. Answering a shot is
    // staying alive, not taking the initiative — the setter sets again, exactly
    // as they would have if the matcher had missed. The turn only leaves them
    // when they miss a shot of their own.
    match.standingShot = null;
    match.phase = PHASE_SET;
    match.turn = match.setter;
    match.lastOutcome = { shooter, made: true, letter: false, kind: "matched" };
    return { accepted: true, ...match.lastOutcome, status: match.status };
  }

  // Missed the standing shot: a letter, and the setter sets again.
  match.players[shooter].letters = Math.min(match.word.length, match.players[shooter].letters + 1);
  match.standingShot = null;
  match.phase = PHASE_SET;
  match.turn = match.setter;
  match.lastOutcome = { shooter, made: false, letter: true, kind: "missed" };

  if (match.players[shooter].letters >= match.word.length) {
    match.status = "won";
    match.winner = other;
  }

  return { accepted: true, ...match.lastOutcome, status: match.status };
}

/**
 * What the CPU does with a turn.
 *
 * Two decisions, and they are deliberately separate. `makeChance` is whether it
 * sinks the shot; `boldness` is how adventurous a bin it places when it is
 * setting. A weak CPU that placed brutal shots would be no easier to beat — it
 * would just miss its own setups all day and never put a letter on anyone. So
 * boldness rises with skill, and the easy CPU sets shots it can mostly hit.
 */
export const HORSE_DIFFICULTIES = Object.freeze([
  Object.freeze({ id: "easy", label: "Easy", makeChance: 0.5, boldness: 0.25 }),
  Object.freeze({ id: "medium", label: "Medium", makeChance: 0.68, boldness: 0.6 }),
  Object.freeze({ id: "hard", label: "Hard", makeChance: 0.85, boldness: 1 }),
]);

export function horseDifficultyById(id) {
  return HORSE_DIFFICULTIES.find((difficulty) => difficulty.id === id) || HORSE_DIFFICULTIES[1];
}

export function cpuMakesHorseShot(difficulty = "medium", random = Math.random) {
  return random() < horseDifficultyById(difficulty).makeChance;
}

/**
 * A bin for the CPU to set.
 *
 * Interpolated out from the middle of the legal volume by `boldness`, rather
 * than sampled uniformly from it: a CPU that placed a random legal bin every
 * turn would be equally wild on Easy and Hard, and difficulty would live
 * entirely in whether it hit its own setup. Boldness is what makes a hard CPU
 * ask a hard question, and the timid end deliberately stays on the floor with a
 * still bin — the shot a new player can actually answer.
 *
 * Motion is unlocked the same way. Below a third of boldness it never moves the
 * bin at all, and the motions it will reach for widen as it gets braver.
 */
export function chooseCpuBinSetup(difficulty = "medium", random = Math.random, motionIds = []) {
  const { boldness } = horseDifficultyById(difficulty);
  // Centred, symmetric, and scaled by boldness: -1..1 out from the middle.
  const spread = (weight) => (random() * 2 - 1) * boldness * weight;

  const motions = boldness < 0.34 || !motionIds.length
    ? ["still"]
    : motionIds.slice(0, Math.max(1, Math.round(motionIds.length * boldness)));

  return {
    // Fractions of the legal span, resolved against the real bounds by the
    // caller's `normalizeBinSetup`. This module owns no geometry.
    lateral: spread(1),
    depth: 0.5 + spread(0.5),
    height: Math.max(0, spread(1)),
    motionId: motions[Math.floor(random() * motions.length)],
  };
}
