// MIRRORED FILE — do not edit here.
//
// Copied verbatim from javascript-games/games/speed-demon/scripts/sim/gate.js
// by that cabinet's tools/mirror-sim.mjs. Edit the original and re-run it.
// The golden-run fixture in both repos fails if these two copies disagree.

// The shifter gate — pure topology, no DOM and no canvas.
//
// The transmission is modelled as a graph of nodes joined by directional edges,
// not as a lookup table of shift sequences. Traversing the graph reproduces the
// real H-pattern movements ("1 -> 2 is down, down"; "2 -> 3 is up, right, up")
// as a consequence of the layout rather than as authored data, which is what
// lets alternate transmissions ship as new gate definitions instead of new code.
//
// Node ids are strings so an attempt can be serialised straight into a network
// payload later without a translation layer.

export const UP = "up";
export const DOWN = "down";
export const LEFT = "left";
export const RIGHT = "right";

const DIRECTIONS = new Set([UP, DOWN, LEFT, RIGHT]);

export const SHIFT_IN_GATE = "in-gate";
export const SHIFT_COMPLETED = "completed";
export const SHIFT_MISSED = "missed";

// Row convention: -1 is the top of the gate, +1 the bottom, 0 the neutral rail.
const ROW_TOP = -1;
const ROW_NEUTRAL = 0;
const ROW_BOTTOM = 1;

/**
 * Standard 6-speed H-pattern. Each gear maps to the gate column it lives in;
 * the first gear declared in a column takes the top slot and the second takes
 * the bottom. Non-standard layouts (dogleg, reverse lockout) may instead give an
 * explicit `{ col, row }` for any gear.
 */
export const GATE_6_SPEED = {
  id: "h6",
  label: "6-Speed H-Pattern",
  gears: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2 },
};

export function gearNodeId(gear) {
  return `gear:${gear}`;
}

export function neutralNodeId(col) {
  return `neutral:${col}`;
}

/**
 * Normalises a gate definition into a node map plus the derived column count.
 * Throws on a malformed definition rather than silently producing a gate with
 * unreachable gears — a broken transmission should fail loudly at load time.
 */
export function createGate(definition) {
  if (!definition || typeof definition !== "object" || !definition.gears) {
    throw new Error("A gate definition requires a `gears` map");
  }

  const nodes = {};
  const gears = [];
  const occupancy = new Map(); // col -> Set of rows already taken
  let maxCol = -1;

  for (const [rawGear, placement] of Object.entries(definition.gears)) {
    const gear = Number(rawGear);
    if (!Number.isInteger(gear)) {
      throw new Error(`Gear keys must be integers, got "${rawGear}"`);
    }

    let col;
    let row;
    if (typeof placement === "number") {
      col = placement;
      const taken = occupancy.get(col) ?? new Set();
      row = taken.has(ROW_TOP) ? ROW_BOTTOM : ROW_TOP;
    } else if (placement && typeof placement === "object") {
      col = placement.col;
      row = placement.row;
    } else {
      throw new Error(`Gear ${gear} needs a column index or a { col, row } placement`);
    }

    if (!Number.isInteger(col) || col < 0) {
      throw new Error(`Gear ${gear} has an invalid column ${col}`);
    }
    if (row !== ROW_TOP && row !== ROW_BOTTOM) {
      throw new Error(`Gear ${gear} must sit on the top or bottom row, got ${row}`);
    }

    const taken = occupancy.get(col) ?? new Set();
    if (taken.has(row)) {
      throw new Error(`Gate slot (col ${col}, row ${row}) is already occupied`);
    }
    taken.add(row);
    occupancy.set(col, taken);

    nodes[gearNodeId(gear)] = { id: gearNodeId(gear), kind: "gear", gear, col, row };
    gears.push(gear);
    maxCol = Math.max(maxCol, col);
  }

  if (gears.length === 0) {
    throw new Error("A gate definition needs at least one gear");
  }

  const columns = maxCol + 1;
  for (let col = 0; col < columns; col += 1) {
    nodes[neutralNodeId(col)] = { id: neutralNodeId(col), kind: "neutral", col, row: ROW_NEUTRAL };
  }

  gears.sort((a, b) => a - b);

  return {
    id: definition.id ?? "gate",
    label: definition.label ?? "Gate",
    columns,
    gears,
    nodes,
  };
}

function gearAt(gate, col, row) {
  for (const node of Object.values(gate.nodes)) {
    if (node.kind === "gear" && node.col === col && node.row === row) {
      return node.id;
    }
  }
  return null;
}

/**
 * The id of the node reached by moving `direction` from `nodeId`, or null when
 * the gate wall blocks that move. Null is the signal the shift reducer turns
 * into a gate error.
 */
export function neighbor(gate, nodeId, direction) {
  const node = gate.nodes[nodeId];
  if (!node || !DIRECTIONS.has(direction)) {
    return null;
  }

  if (node.kind === "gear") {
    // A gear only connects back to the neutral rail, and only in the direction
    // that moves toward it. Everything else is a wall.
    const towardRail = node.row === ROW_TOP ? DOWN : UP;
    return direction === towardRail ? neutralNodeId(node.col) : null;
  }

  switch (direction) {
    case UP:
      return gearAt(gate, node.col, ROW_TOP);
    case DOWN:
      return gearAt(gate, node.col, ROW_BOTTOM);
    case LEFT:
      return node.col > 0 ? neutralNodeId(node.col - 1) : null;
    case RIGHT:
      return node.col < gate.columns - 1 ? neutralNodeId(node.col + 1) : null;
    default:
      return null;
  }
}

/**
 * Shortest input sequence from one gear to another. Used by tests to prove the
 * brief's sequences emerge from the geometry, and available later for tutorial
 * ghosts or an assisted-shift mode.
 */
export function pathBetweenGears(gate, fromGear, toGear) {
  const start = gearNodeId(fromGear);
  const goal = gearNodeId(toGear);
  if (!gate.nodes[start] || !gate.nodes[goal]) {
    throw new Error(`Gate has no path between gear ${fromGear} and gear ${toGear}`);
  }
  if (start === goal) {
    return [];
  }

  const queue = [start];
  const cameFrom = new Map([[start, null]]);

  while (queue.length > 0) {
    const current = queue.shift();
    for (const direction of [UP, DOWN, LEFT, RIGHT]) {
      const next = neighbor(gate, current, direction);
      if (!next || cameFrom.has(next)) {
        continue;
      }
      cameFrom.set(next, { node: current, direction });
      if (next === goal) {
        const path = [];
        let cursor = next;
        while (cameFrom.get(cursor)) {
          const step = cameFrom.get(cursor);
          path.unshift(step.direction);
          cursor = step.node;
        }
        return path;
      }
      queue.push(next);
    }
  }

  throw new Error(`Gear ${toGear} is unreachable from gear ${fromGear}`);
}

/**
 * Opens the gate for a shift. The knob starts parked in the origin gear, which
 * is where it physically is at the moment the clutch goes in.
 */
export function beginShift(gate, fromGear, toGear) {
  if (!gate.nodes[gearNodeId(fromGear)]) {
    throw new Error(`Gate has no gear ${fromGear}`);
  }
  if (!gate.nodes[gearNodeId(toGear)]) {
    throw new Error(`Gate has no gear ${toGear}`);
  }
  return {
    node: gearNodeId(fromGear),
    fromGear,
    toGear,
    gateErrors: 0,
    inputs: 0,
    status: SHIFT_IN_GATE,
    landedGear: null,
  };
}

/**
 * Applies one directional input. Always returns a new attempt object; the caller
 * owns the previous one. Outcomes:
 *
 *   - blocked by a wall  -> knob holds position, one gate error recorded
 *   - lands on target    -> completed
 *   - lands on origin    -> attempt resets (harmless mechanically), one error
 *   - lands anywhere else-> missed, a money shift
 */
export function applyShiftInput(gate, attempt, direction) {
  if (attempt.status !== SHIFT_IN_GATE || !DIRECTIONS.has(direction)) {
    return { ...attempt };
  }

  const next = neighbor(gate, attempt.node, direction);

  if (next === null) {
    return { ...attempt, gateErrors: attempt.gateErrors + 1, inputs: attempt.inputs + 1 };
  }

  const moved = { ...attempt, node: next, inputs: attempt.inputs + 1 };
  const node = gate.nodes[next];
  if (node.kind !== "gear") {
    return moved;
  }

  if (node.gear === attempt.toGear) {
    return { ...moved, status: SHIFT_COMPLETED, landedGear: node.gear };
  }
  if (node.gear === attempt.fromGear) {
    // Back where we started: costs time and counts as sloppy gate work, but the
    // transmission is fine, so the attempt stays live.
    return { ...moved, gateErrors: moved.gateErrors + 1 };
  }
  return { ...moved, status: SHIFT_MISSED, landedGear: node.gear };
}
