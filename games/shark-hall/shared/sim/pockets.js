// When a ball is in a pocket, which is two questions rather than one.
//
// Pure. No THREE, no DOM.
//
// A BALL DROPS TWO WAYS, and both are needed. It can arrive at a pocket centre
// while it is still moving, which is `checkPocket`; or it can trickle onto the
// shelf, stop, and sit balanced on the lip, which is `captureHangingBalls`. The
// second is what the settle delay in `constants.js` exists for: score the shot
// the instant motion ceased and a hanging ball is credited to the next player.
//
// THE SHELF IS ALSO A POCKET. A ball that has cleanly crossed a mouth is past
// the cushions entirely, and the rail colliders no longer apply to it. Without
// the bounds checks below it would sail off the cloth and keep going forever,
// because nothing is out there to stop it.

import { BALL_RADIUS, CORNER_GAP, HALF_LENGTH, HALF_WIDTH, HANGING_SPEED, SIDE_GAP } from "./constants.js";
import { POCKETS } from "./table.js";
import { speedOf, stillBall } from "./balls.js";

/** Mark a ball pocketed. Idempotent; returns whether this call was the one that did it. */
export function pocketBall(ball) {
  if (ball.pocketed) return false;
  ball.pocketed = true;
  stillBall(ball);
  return true;
}

/**
 * Has this ball fallen in?
 *
 * Returns the pocket it fell into, or null. Does not mutate — `world.js` decides
 * what to do about it, so this stays a question rather than an action.
 */
export function findPocket(ball) {
  for (const pocket of POCKETS) {
    if (Math.hypot(ball.x - pocket.x, ball.z - pocket.z) < pocket.radius) return pocket;
  }

  // Past the cushions and over a mouth: the shelf has it, wherever exactly it
  // went. Losing the ball off the end of the table is the alternative.
  if (Math.abs(ball.x) > HALF_LENGTH + BALL_RADIUS * 0.25 && Math.abs(ball.z) > HALF_WIDTH - CORNER_GAP) {
    return nearestPocket(ball);
  }
  if (
    Math.abs(ball.z) > HALF_WIDTH + BALL_RADIUS * 0.25 &&
    (Math.abs(ball.x) < SIDE_GAP || Math.abs(ball.x) > HALF_LENGTH - CORNER_GAP)
  ) {
    return nearestPocket(ball);
  }

  return null;
}

/** The pocket a ball is closest to. Used when it has left the cloth past a mouth. */
export function nearestPocket(ball) {
  let best = POCKETS[0];
  let bestDistance = Infinity;
  for (const pocket of POCKETS) {
    const distance = Math.hypot(ball.x - pocket.x, ball.z - pocket.z);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = pocket;
    }
  }
  return best;
}

/**
 * Take every ball that has come to rest hanging over a lip.
 *
 * Only balls that are effectively stopped are considered, and the capture radius
 * is generously wider than the drop radius — a ball that has stopped that far
 * into a pocket mouth is not going to climb back out, and leaving it balanced
 * there looks like a bug rather than like a table.
 *
 * @returns the balls it took, so the caller can report them.
 */
export function captureHangingBalls(balls) {
  const captured = [];
  for (const ball of balls) {
    if (ball.pocketed || speedOf(ball) > HANGING_SPEED) continue;
    for (const pocket of POCKETS) {
      const lip = pocket.radius + BALL_RADIUS * 0.58;
      if (Math.hypot(ball.x - pocket.x, ball.z - pocket.z) < lip) {
        if (pocketBall(ball)) captured.push({ ball, pocket });
        break;
      }
    }
  }
  return captured;
}
