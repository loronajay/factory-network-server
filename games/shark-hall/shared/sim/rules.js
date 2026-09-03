// House 8-ball, as one pure function.
//
// `resolveShot` takes the state of the table after everything stopped rolling
// and returns what that means. It reads no DOM, schedules no CPU, plays no
// sound and mutates nothing — hand it the same shot twice and it answers the
// same way twice, which is what makes the rules testable at all.
//
// In the demo this logic lived inside `endShot()` interleaved with element
// updates and `setTimeout` calls, and every rule question ("does a safety on an
// open table pass the turn?") had to be answered by reading render code.
//
// THE RULES, in the order they are applied:
//
//   1. Cue ball pocketed is a scratch, and a scratch is ball in hand BEHIND THE
//      HEAD STRING. Every other foul is ball in hand anywhere. This is the one
//      place the two zones are distinguished.
//   2. Hitting nothing is a foul.
//   3. Once a player has a group, the first ball struck must be from it — except
//      when their group was ALREADY cleared when they struck, in which case it
//      must be the 8. On an open table only striking the 8 first is a foul.
//   4. After contact, either a ball goes down or some ball must reach a rail.
//   5. The 8 on the break is not a loss; it is a rerack.
//   6. Groups are assigned by the first legal pot after the break, never on it.
//   7. The shooter continues only on a legal pot of a ball that is theirs.
//
// Pure. No THREE, no DOM.

import { EIGHT, CUE, groupOf, inGroup, opposingGroup, remaining } from "./balls.js";
import { ZONE_ANYWHERE, ZONE_KITCHEN, ZONE_NONE } from "./placement.js";

/**
 * @typedef {object} ShotReport
 * @property {number[]} pocketed              ball numbers that went down, in order
 * @property {number|null} firstHit           first object ball the cue ball touched
 * @property {boolean} cushionAfterContact    any ball reached a rail after that contact
 */

/**
 * @typedef {object} ShotOutcome
 * @property {boolean} rerack       the 8 went down on the break; start over
 * @property {boolean} foul
 * @property {boolean} scratch
 * @property {string|null} foulReason   why, in one short phrase
 * @property {(string|null)[]} groups   possibly newly assigned
 * @property {boolean} turnChanged
 * @property {number} nextShooter
 * @property {string} ballInHand    a zone from `placement.js`
 * @property {number|null} winner   seat that won, or null
 * @property {string} kicker        headline for the turn card
 * @property {string} reason        one line explaining the outcome
 */

/**
 * Score a completed shot.
 *
 * @param balls   the table AFTER the shot, pocketed flags already set
 * @param context `{ shooter, groups, isBreak }`
 * @param report  what happened during the shot
 * @returns {ShotOutcome}
 */
export function resolveShot(balls, { shooter, groups, isBreak }, report) {
  const other = 1 - shooter;
  const group = groups[shooter];

  const pocketed = report.pocketed || [];
  const scratch = pocketed.includes(CUE);
  const eightDown = pocketed.includes(EIGHT);
  const objectPots = pocketed.filter((n) => n !== CUE && n !== EIGHT);

  // "Was the shooter on the 8?" is a question about the table as it stood when
  // they STRUCK, not as it settled. `balls` is the settled table, so the balls
  // this shot removed have to be added back before counting. Asking the settled
  // table instead says yes the instant the last group ball drops, and then the
  // rack-clearing pot itself is scored "Wrong ball first" — a foul for potting
  // your own ball, always on the last ball of a group. That was the bug.
  const groupPotsThisShot = group ? objectPots.filter((n) => inGroup(n, group)).length : 0;
  const wasOnTheEight = Boolean(group) && remaining(balls, group) + groupPotsThisShot === 0;

  // --- fouls -------------------------------------------------------------
  let foulReason = null;
  if (scratch) foulReason = "Scratch";
  else if (report.firstHit === null) foulReason = "No ball struck";
  else if (!isBreak && group) {
    if (wasOnTheEight && report.firstHit !== EIGHT) foulReason = "Wrong ball first";
    else if (!wasOnTheEight && !inGroup(report.firstHit, group)) foulReason = "Wrong ball first";
  } else if (!isBreak && !group && report.firstHit === EIGHT) {
    foulReason = "Struck the 8 on an open table";
  }

  // The table scratch: contact was made, nothing dropped, and nothing reached a
  // rail. Checked last so a more specific foul keeps its own name.
  if (
    !foulReason &&
    report.firstHit !== null &&
    objectPots.length === 0 &&
    !eightDown &&
    !report.cushionAfterContact
  ) {
    foulReason = "No rail after contact";
  }

  const foul = foulReason !== null;

  // --- the 8 -------------------------------------------------------------
  if (eightDown) {
    // Rule 5. Every ruleset does something different here; the house rule is the
    // friendliest one, and it is the only branch that reports a rerack.
    if (isBreak) {
      return {
        rerack: true,
        foul: false,
        scratch,
        foulReason: null,
        groups: [...groups],
        turnChanged: false,
        nextShooter: shooter,
        ballInHand: ZONE_NONE,
        winner: null,
        kicker: "Rerack",
        reason: "8-ball on the break",
      };
    }

    // Same pre-shot reading: the group has to have been clear BEFORE the stroke,
    // so dropping the last group ball and the 8 together is still a loss.
    const legal = wasOnTheEight && !foul && report.firstHit === EIGHT;
    const winner = legal ? shooter : other;

    return {
      rerack: false,
      foul,
      scratch,
      foulReason,
      groups: [...groups],
      turnChanged: !legal,
      nextShooter: winner,
      ballInHand: ZONE_NONE,
      winner,
      kicker: legal ? "Rack complete" : "Illegal 8",
      reason: legal ? "Clean 8-ball" : foulReason ? `${foulReason} on the 8` : "8-ball made early",
    };
  }

  // --- group assignment --------------------------------------------------
  // Rule 6. Never on the break, never off a foul, and taken from the FIRST ball
  // down rather than the majority — a shot that drops one of each is called by
  // whichever fell first, which is the order `pocketed` is in.
  const nextGroups = [...groups];
  if (!isBreak && !group && !foul && objectPots.length) {
    const claimed = groupOf(objectPots[0]);
    if (claimed) {
      nextGroups[shooter] = claimed;
      nextGroups[other] = opposingGroup(claimed);
    }
  }

  // --- who shoots next ---------------------------------------------------
  // Rule 7. Against the group the shooter now has: a player who just earned
  // stripes by dropping a stripe has made a legal pot, not a foul.
  const shooterGroup = nextGroups[shooter];
  const legalPot = !foul && (shooterGroup ? objectPots.some((n) => inGroup(n, shooterGroup)) : objectPots.length > 0);
  const turnChanged = foul || !legalPot;

  return {
    rerack: false,
    foul,
    scratch,
    foulReason,
    groups: nextGroups,
    turnChanged,
    nextShooter: turnChanged ? other : shooter,
    ballInHand: foul ? (scratch ? ZONE_KITCHEN : ZONE_ANYWHERE) : ZONE_NONE,
    winner: null,
    kicker: foul ? "Foul" : turnChanged ? "Turn over" : "Still shooting",
    reason: foul
      ? `${foulReason} · ball in hand`
      : legalPot
        ? "Shooter continues"
        : "No legal ball made",
  };
}

/** The group label the HUD shows for a seat. */
export function groupLabel(group) {
  if (group === "solid") return "SOLIDS";
  if (group === "stripe") return "STRIPES";
  return "OPEN";
}

/**
 * What a ball IS, in words, for the seat currently at the table.
 *
 * The hover readout exists because a striped ball seen edge-on from the cue view
 * reads as a solid, and no amount of camera work fixes that at a distance. So
 * the question is answered in print instead — and it answers the useful half
 * too, which is not "what number is that" but "is that one mine".
 *
 * `mine` is null on an open table and for the cue ball and the 8, because on an
 * open table nothing is anyone's yet and those two are never in a group.
 *
 * @param group the shooter's group, or null on an open table
 * @returns `{ number, kind, name, mine }`
 */
export function describeBall(n, group = null) {
  if (n === CUE) return { number: CUE, kind: "cue", name: "Cue ball", mine: null };
  if (n === EIGHT) return { number: EIGHT, kind: "eight", name: "8 ball", mine: null };
  const kind = groupOf(n);
  return {
    number: n,
    kind,
    name: `${n} · ${kind === "solid" ? "Solid" : "Stripe"}`,
    mine: group ? kind === group : null,
  };
}
