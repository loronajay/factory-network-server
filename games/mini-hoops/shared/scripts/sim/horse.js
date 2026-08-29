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
 * THE TOOLS A MATCHER OWES.
 *
 * A setter may build a whole apparatus — a springboard, a cannon, a pad to bank
 * off — and before this rule existed the matcher could ignore every piece of it
 * and drop the ball straight in the bin, which makes the tools scenery. So a
 * made SET shot records the tools it actually touched, and the matching shot is
 * only a match if it touches all of them too.
 *
 * IT IS THE TOOLS THE SETTER TOUCHED, NOT THE TOOLS THEY PUT DOWN. A pad the
 * setter arranged and then flew past is not part of the shot they made, and
 * holding a matcher to it would be asking for a shot nobody has proved. It also
 * closes the obvious abuse from the other side: a setter cannot litter the room
 * with unreachable tools, because the only ones that count are the ones their
 * own ball found.
 *
 * UNORDERED, AND DELIBERATELY. "Off the pad, into the cannon, into the bin" and
 * "into the cannon, off the pad, into the bin" are different shots, but the
 * second is usually not physically available anyway, and a rule about ORDER is
 * one the HUD cannot state in a line and the player cannot see being broken.
 * Touch them all and the make stands.
 */
export function requiredPieceIds(setup) {
  const available = new Set((Array.isArray(setup?.pieces) ? setup.pieces : []).map((piece) => piece?.id));
  const required = Array.isArray(setup?.requiredPieces) ? setup.requiredPieces : [];
  // Intersected with the tools that are really there: a duty naming a piece the
  // setup does not carry is one no shot could ever discharge.
  return [...new Set(required.map(String).filter((id) => available.has(id)))];
}

/** Which of a standing shot's required tools an attempt failed to touch. */
export function unmetPieceIds(setup, touched = []) {
  const hit = new Set((Array.isArray(touched) ? touched : []).map(String));
  return requiredPieceIds(setup).filter((id) => !hit.has(id));
}

/**
 * Stamp a made setter's setup with the duty it just proved.
 *
 * Called with what the setter's own ball touched, so the record that becomes the
 * standing shot carries both the apparatus and the part of it that counts.
 *
 * THE PULL THAT PROVED IT TRAVELS TOO, when there is a duty. A shot through an
 * apparatus is not one a matcher can find by aiming at the target — that is the
 * whole point of the rule — and the CPU has no hands to learn it with, so the
 * one pull already known to route the whole way is recorded with the shot it
 * made. `sim/horse-cpu.js` is the only thing that reads it, and what it does
 * with it is exactly what the mode asks a person for: repeat the shot.
 *
 * It is recorded ONLY for a shot with a duty. A plain standing shot is one the
 * CPU's own lead already answers, and a pull on every setup would be state
 * replicated, serialized and reconnected through for nothing.
 */
export function recordShotDuty(setup, touched = [], pull = null) {
  if (!setup) return setup;
  const hit = new Set((Array.isArray(touched) ? touched : []).map(String));
  const pieces = Array.isArray(setup.pieces) ? setup.pieces : [];
  const requiredPieces = pieces.map((piece) => piece?.id).filter((id) => hit.has(id));
  const stamped = { ...setup, requiredPieces };
  if (requiredPieces.length > 0 && pull) stamped.provenPull = normalizeProvenPull(pull);
  else delete stamped.provenPull;
  return stamped;
}

/** The four numbers a shot can be repeated from, and nothing else off the wire. */
export function normalizeProvenPull(pull = {}) {
  const number = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    power: number(pull.power),
    aimX: number(pull.aimX),
    loft: number(pull.loft, 1),
    motionSeconds: Math.max(0, number(pull.motionSeconds)),
  };
}

/**
 * Did this shot count?
 *
 * Going in is necessary and, while MATCHING, no longer sufficient. Split out
 * from `resolveHorseShot` because the caller has to know WHY a make did not
 * stand — the HUD says so, and "you missed" is the wrong sentence for a ball
 * that went cleanly through the bin having skipped the springboard.
 *
 * A SETTER IS NEVER HELD TO A DUTY. They are inventing the shot; whatever their
 * ball touches on the way in becomes the duty, so there is nothing to check.
 */
export function judgeHorseShot(match, { scored = false, touched = [] } = {}) {
  if (match?.phase !== PHASE_MATCH) return { made: scored === true, unmet: [] };
  const unmet = scored === true ? unmetPieceIds(match.standingShot, touched) : [];
  return { made: scored === true && unmet.length === 0, unmet };
}

/**
 * Resolve a completed shot.
 *
 * @param setup the bin setup the shot was taken against — recorded as the
 *              standing shot when a setter makes one.
 * @param unmet the required tools this attempt skipped, from `judgeHorseShot`.
 * @param pull  the pull that took this shot, recorded with a setter's make so
 *              a shot through an apparatus can be repeated. See `recordShotDuty`.
 * @param touched the tools this shot really hit. A made setter's setup is
 *              stamped with them on the way in, so the duty is recorded in the
 *              one place that stores a standing shot rather than at every
 *              caller that might forget to.
 * @returns a description of what changed, for the HUD; the match is mutated.
 */
export function resolveHorseShot(match, made, setup = null, { unmet = [], touched = null, pull = null } = {}) {
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
      match.standingShot = touched ? recordShotDuty(setup, touched, pull) : setup;
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
  // `skipped` separates the two ways a matcher loses a letter: the ball did
  // not go in, or it did and left one of the setter's tools untouched. The
  // second reads as a bug unless the HUD says which it was.
  match.lastOutcome = { shooter, made: false, letter: true, kind: "missed", skipped: unmet.length > 0 };

  if (match.players[shooter].letters >= match.word.length) {
    match.status = "won";
    match.winner = other;
  }

  return { accepted: true, ...match.lastOutcome, status: match.status };
}

/**
 * What the CPU does with a turn.
 *
 * Three decisions, and they are deliberately separate. `makeChance` is whether
 * it sinks the shot; `boldness` is how adventurous a target it places when it is
 * setting. A weak CPU that placed brutal shots would be no easier to beat — it
 * would just miss its own setups all day and never put a letter on anyone. So
 * boldness rises with skill, and the easy CPU sets shots it can mostly hit.
 *
 * `trickChance` is the third, and it is stated separately from boldness rather
 * than derived off it because it is not a harder question of the same kind — it
 * is a DIFFERENT kind of question. A trick shot has an apparatus in it, so the
 * answer is not a pull anyone can find by aiming; the opponent has to be shown
 * the recipe and repeat it. The easy CPU never asks one, and that is a floor
 * rather than a curve: the first thing a new player has to learn is the meter,
 * and there is nothing in this that teaches it.
 */
export const HORSE_DIFFICULTIES = Object.freeze([
  Object.freeze({ id: "easy", label: "Easy", makeChance: 0.5, boldness: 0.25, trickChance: 0 }),
  Object.freeze({ id: "medium", label: "Medium", makeChance: 0.68, boldness: 0.6, trickChance: 0.35 }),
  Object.freeze({ id: "hard", label: "Hard", makeChance: 0.85, boldness: 1, trickChance: 0.5 }),
]);

export function horseDifficultyById(id) {
  return HORSE_DIFFICULTIES.find((difficulty) => difficulty.id === id) || HORSE_DIFFICULTIES[1];
}

export function cpuMakesHorseShot(difficulty = "medium", random = Math.random) {
  return random() < horseDifficultyById(difficulty).makeChance;
}

/**
 * Does the CPU reach for an apparatus this turn?
 *
 * Asked BEFORE the target is placed and separately from whether one could be
 * built, because the two are different failures and only one of them is a
 * decision. A CPU that declined is setting a plain shot on purpose; a CPU whose
 * plan did not converge is setting one because `sim/horse-plan.js` could not
 * prove anything, and the mode's own rule is that a shot nobody has made is not
 * a shot anybody owes.
 */
export function cpuSetsTrickShot(difficulty = "medium", random = Math.random) {
  return random() < (horseDifficultyById(difficulty).trickChance || 0);
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

/**
 * The target the CPU sets a shot at.
 *
 * The FIRST of a setter's four decisions, because it decides which motion
 * catalog the second one is drawn from. Unlocked by boldness the way the motions
 * and the balls are, and for the same reason: the timid end stays on the floor
 * bin, whose gesture a new player has already been taught by the mode itself,
 * and a braver CPU will hang the hoop and ask for the cabinet's classic pull
 * instead. Below a third of boldness it never reaches past the first kind.
 *
 * The list comes from the caller, so this module still owns no catalog. It
 * relies on that list being ordered from the plainest question to the boldest —
 * the same contract `chooseCpuTurnBall` relies on for the ball roster.
 */
export function chooseCpuTargetKind(difficulty = "medium", random = Math.random, kinds = []) {
  if (!kinds.length) return null;
  const { boldness } = horseDifficultyById(difficulty);
  const reach = boldness < 0.34 ? 1 : Math.max(1, Math.round(kinds.length * boldness));
  return kinds[Math.floor(random() * Math.min(reach, kinds.length))];
}

/**
 * The ball the CPU sets a shot with.
 *
 * The ball is part of the standing shot, so this is a real decision and not a
 * skin: whatever the CPU picks is the ball its opponent then owes the shot in.
 * Unlocked by boldness exactly the way the motions are, and for the same
 * reason — the timid end stays on the reference ball, which is the one a new
 * player has already learned the meter for, and a braver CPU reaches further
 * down the list to hand over something that flies differently.
 *
 * The ids come from the caller, so this module still owns no catalog. It relies
 * on that list being the catalog's own order, whose first entry is the
 * reference ball.
 */
export function chooseCpuTurnBall(difficulty = "medium", random = Math.random, ballIds = []) {
  if (!ballIds.length) return null;
  const { boldness } = horseDifficultyById(difficulty);
  const reach = boldness < 0.34 ? 1 : Math.max(1, Math.round(ballIds.length * boldness));
  return ballIds[Math.floor(random() * Math.min(reach, ballIds.length))];
}
