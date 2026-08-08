// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/sim/input-log.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

// The canonical record of what a driver did, and the machinery to replay it.
//
// PURE. This is the module online play is actually built on, and it exists
// because of a property `race.js` already had: every mutation there is a
// function returning a fresh race, with no clock and no randomness anywhere in
// `sim/`. A run is therefore *entirely* determined by its options plus the
// inputs that were made, and nothing else — so a log of those inputs is a
// complete, replayable description of a run.
//
// Three callers want exactly that, which is why it is one module rather than
// three:
//
//   - **The driver's own client** records as it drives, so it has something to
//     send.
//   - **The opponent's client** replays the stream to draw the other car. It
//     runs the same sim on the same inputs, so the two machines converge by
//     construction rather than by correction.
//   - **The server** replays both logs to decide the round. That is what makes
//     "server authoritative" mean something here: a client can only ever claim
//     *inputs*, and the server decides what those inputs achieved. A client
//     that reports its own finishing time is not being adjudicated, it is being
//     believed.
//
// A log is small. A quarter mile is ~720 ticks but only about thirty events,
// because the throttle is recorded as edges and the gate as the handful of
// directions actually pressed.

import { TICK_SECONDS } from "./constants.mjs";
import { createRace, startRace, stepRace, pressShift, gateInput, FINISHED, STAGING } from "./race.mjs";

/**
 * The four things a driver can do. Single characters because every one of these
 * crosses the wire on every tick of a live race.
 *
 * `EVENT_THROTTLE` is a *level* and the other three are events — that asymmetry
 * is the same one `input.js` draws between held state and queued actions, and it
 * is why the replay resolves the throttle separately from the rest.
 */
export const EVENT_START = "s";
export const EVENT_THROTTLE = "t";
export const EVENT_CLUTCH = "c";
export const EVENT_GATE = "g";

/** Gate directions, indexed. The value that rides on an `EVENT_GATE`. */
export const GATE_DIRECTIONS = ["up", "down", "left", "right"];

export function createInputLog() {
  return { events: [], throttle: 0 };
}

/**
 * Records the throttle only when it *changes*.
 *
 * The throttle is held for most of a run, so logging its level every tick would
 * make the log two orders of magnitude larger for no added information. The
 * replay reads the most recent edge at or before a tick, which reconstructs the
 * level exactly.
 */
export function recordThrottle(log, tick, throttle) {
  const level = throttle > 0 ? 1 : 0;
  if (level === log.throttle) {
    return log;
  }
  return {
    throttle: level,
    events: [...log.events, { t: tick, k: EVENT_THROTTLE, v: level }],
  };
}

/** Records one discrete action — leaving staging, the clutch, or a gate move. */
export function recordEvent(log, tick, kind, value = 0) {
  return { ...log, events: [...log.events, { t: tick, k: kind, v: value }] };
}

export function recordStart(log, tick) {
  return recordEvent(log, tick, EVENT_START);
}

export function recordClutch(log, tick) {
  return recordEvent(log, tick, EVENT_CLUTCH);
}

export function recordGate(log, tick, direction) {
  const index = GATE_DIRECTIONS.indexOf(direction);
  return index < 0 ? log : recordEvent(log, tick, EVENT_GATE, index);
}

/** Everything from `afterTick` onward, so a live stream can send only the new part. */
export function eventsSince(log, afterTick) {
  return log.events.filter((event) => event.t >= afterTick);
}

/**
 * Folds received events into a log. Used by the side *watching* a run rather
 * than driving it.
 *
 * Duplicates are dropped rather than trusted: a resend after a dropped frame is
 * normal, and applying one twice would put a phantom gate move into the
 * opponent's car. Two genuinely identical events on the same tick cannot happen
 * — `input.js` refuses auto-repeat, and a second clutch request on the same tick
 * as the first is a no-op in `pressShift` anyway — so identity is a safe test.
 */
export function mergeEvents(log, incoming) {
  const seen = new Set(log.events.map(keyOf));
  const added = [];
  for (const event of incoming ?? []) {
    const normalized = { t: Math.trunc(event.t), k: event.k, v: event.v ?? 0 };
    if (!Number.isFinite(normalized.t) || normalized.t < 0) continue;
    if (!KINDS.has(normalized.k)) continue;
    const key = keyOf(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(normalized);
  }
  if (added.length === 0) {
    return log;
  }
  // Sorted by tick, stable within one, so replay order never depends on the
  // order packets happened to arrive in.
  const events = [...log.events, ...added].sort((a, b) => a.t - b.t);
  return { ...log, events };
}

const KINDS = new Set([EVENT_START, EVENT_THROTTLE, EVENT_CLUTCH, EVENT_GATE]);
const keyOf = (event) => `${event.t}:${event.k}:${event.v ?? 0}`;

/** The throttle level in force on `tick`, reconstructed from the edges. */
export function throttleAt(log, tick) {
  let level = 0;
  for (const event of log.events) {
    if (event.t > tick) break;
    if (event.k === EVENT_THROTTLE) level = event.v;
  }
  return level;
}

/**
 * Replays a log into a finished race.
 *
 * The tick shape here mirrors `init-game.js`'s loop exactly, and it has to:
 * discrete actions first, in order, then one `stepRace` with the tick's throttle
 * level. The live loop samples the throttle once per tick and uses that one
 * value for both `pressShift` and `stepRace`, so the level is constant across a
 * tick — which is what lets the replay resolve it up front and removes any
 * question of how a throttle edge and a clutch press on the same tick order
 * against each other.
 *
 * `maxTicks` is a bound, not a duration: a log that never crosses the line (a
 * disconnect, or a malformed one from a client trying its luck) has to stop
 * somewhere rather than spinning the server.
 */
export function replayRun(options, log, { maxTicks = MAX_REPLAY_TICKS } = {}) {
  let race = createRace(options);
  // Sorted here rather than trusted, because a log that arrived over the wire
  // was assembled from packets. `mergeEvents` already sorts, but replay is the
  // one place correctness depends on the order, so it establishes it itself.
  const events = [...(log?.events ?? [])].sort((a, b) => a.t - b.t);

  let cursor = 0;
  let throttle = 0;
  for (let tick = 0; tick <= maxTicks; tick += 1) {
    // Everything on this tick, in the order it was recorded. The throttle is
    // resolved across the whole tick before any of them are applied — the live
    // loop samples it once per frame and hands that one value to both
    // `pressShift` and `stepRace`, so within a tick it is a constant. That is
    // what settles how a lift and a clutch press landing on the same tick order
    // against each other: the press sees the lift, which is the difference
    // between arming the clutch and opening the gate, and so between two grades.
    const start = cursor;
    while (cursor < events.length && events[cursor].t === tick) {
      if (events[cursor].k === EVENT_THROTTLE) throttle = events[cursor].v;
      cursor += 1;
    }
    for (let i = start; i < cursor; i += 1) {
      race = applyEvent(race, events[i], throttle);
    }

    race = stepRace(race, { throttle }, TICK_SECONDS);
    if (race.phase === FINISHED) {
      return { race, ticks: tick + 1, complete: true };
    }
    // A race still in staging with no inputs left will never start, and
    // `stepRace` is inert on it — so walking the rest of the ceiling can only
    // produce the same answer more slowly. Every other stalled case genuinely
    // has to be simulated: a car that has been lifted off still coasts, and
    // rolling resistance is light enough that it can take a minute and a half
    // to trickle across a quarter mile. That is a real result, not a hang.
    if (race.phase === STAGING && cursor >= events.length) {
      return { race, ticks: tick + 1, complete: false };
    }
  }
  return { race, ticks: maxTicks + 1, complete: false };
}

function applyEvent(race, event, throttle) {
  switch (event.k) {
    case EVENT_START:
      return startRace(race);
    case EVENT_CLUTCH:
      return pressShift(race, { throttle });
    case EVENT_GATE:
      return gateInput(race, GATE_DIRECTIONS[event.v] ?? "up");
    // A throttle edge changes the level the tick runs at rather than doing
    // anything to the race on its own, and that has already been resolved.
    default:
      return race;
  }
}

/**
 * Ten minutes at 60hz — past any legitimate run, including the two-minute Time
 * Attack clock and a mile driven badly. It is a ceiling on a hostile log rather
 * than a duration: a real quarter mile exits at around 900 ticks.
 */
export const MAX_REPLAY_TICKS = 36000;
