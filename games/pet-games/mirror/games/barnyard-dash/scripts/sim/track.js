const COURSE = {
  start: Object.freeze({ x: 133, y: 490, angle: -Math.PI / 2 }),
  finish: Object.freeze({ x: 130, y: 450, angle: -Math.PI / 2 }),
  roadWidth: 132,
  road: Object.freeze([
    Object.freeze({ x: 135, y: 510 }),
    Object.freeze({ x: 118, y: 350 }),
    Object.freeze({ x: 145, y: 205 }),
    Object.freeze({ x: 265, y: 115 }),
    Object.freeze({ x: 450, y: 88 }),
    Object.freeze({ x: 650, y: 115 }),
    Object.freeze({ x: 790, y: 220 }),
    Object.freeze({ x: 835, y: 370 }),
    Object.freeze({ x: 760, y: 515 }),
    Object.freeze({ x: 590, y: 585 }),
    Object.freeze({ x: 370, y: 590 }),
    Object.freeze({ x: 205, y: 545 }),
    Object.freeze({ x: 135, y: 510 }),
  ]),
  // Each checkpoint is a GATE: a line across the whole fenced course at that
  // point (see withCheckpointGates), so a lap counts no matter which part of
  // the track's width the racer used.
  checkpoints: Object.freeze([
    Object.freeze({ x: 130, y: 260 }),
    Object.freeze({ x: 265, y: 115 }),
    Object.freeze({ x: 650, y: 115 }),
    Object.freeze({ x: 835, y: 370 }),
    Object.freeze({ x: 760, y: 515 }),
    Object.freeze({ x: 370, y: 590 }),
    Object.freeze({ x: 130, y: 450 }),
  ]),
  mud: Object.freeze([
    Object.freeze({ x: 475, y: 96, width: 145, height: 82 }),
    Object.freeze({ x: 810, y: 310, width: 100, height: 120 }),
  ]),
  obstacles: Object.freeze([
    Object.freeze({ id: "hurdle-1", kind: "hurdle", x: 120, y: 330, length: 116, thickness: 4, angle: 0.06 }),
    Object.freeze({ id: "hurdle-2", kind: "hurdle", x: 205, y: 160, length: 116, thickness: 4, angle: 0.93 }),
    Object.freeze({ id: "hurdle-3", kind: "hurdle", x: 560, y: 103, length: 116, thickness: 4, angle: 1.70 }),
    Object.freeze({ id: "hurdle-4", kind: "hurdle", x: 740, y: 182, length: 116, thickness: 4, angle: 2.21 }),
    Object.freeze({ id: "hay-1", kind: "hay", x: 690, y: 145, radius: 21 }),
    Object.freeze({ id: "gate-1", kind: "gate", x: 820, y: 400, length: 52, thickness: 5, angle: 0.48 }),
    Object.freeze({ id: "hurdle-5", kind: "hurdle", x: 790, y: 455, length: 116, thickness: 4, angle: 0.48 }),
    Object.freeze({ id: "hurdle-6", kind: "hurdle", x: 555, y: 586, length: 116, thickness: 4, angle: 1.55 }),
    Object.freeze({ id: "hurdle-7", kind: "hurdle", x: 285, y: 567, length: 116, thickness: 4, angle: 1.84 }),
  ]),
};

/** Tile a broad checkered band perpendicular to the starting heading. */
export function startLineTiles(track, columns = 12, rows = 3) {
  const line = track.finish ?? track.start;
  const width = Math.max(1, track.roadWidth - 12);
  const tileWidth = width / columns;
  const tileDepth = 7;
  const acrossX = -Math.sin(line.angle);
  const acrossY = Math.cos(line.angle);
  const forwardX = Math.cos(line.angle);
  const forwardY = Math.sin(line.angle);
  const tiles = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const across = (column - (columns - 1) / 2) * tileWidth;
      const forward = (row - (rows - 1) / 2) * tileDepth;
      tiles.push({
        x: line.x + acrossX * across + forwardX * forward,
        y: line.y + acrossY * across + forwardY * forward,
        angle: line.angle,
        width: tileWidth,
        depth: tileDepth,
        row,
        column,
        dark: (row + column) % 2 === 0,
      });
    }
  }
  return tiles;
}

export function pointInRect(point, rect) {
  return point.x >= rect.x - rect.width / 2 && point.x <= rect.x + rect.width / 2
    && point.y >= rect.y - rect.height / 2 && point.y <= rect.y + rect.height / 2;
}

function closestPointOnSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const amount = lengthSquared ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared)) : 0;
  const x = start.x + dx * amount;
  const y = start.y + dy * amount;
  const distance = Math.hypot(point.x - x, point.y - y);
  return { x, y, distance, amount };
}

export function closestPointOnRoad(point, track) {
  let closest = null;
  for (let index = 1; index < track.road.length; index += 1) {
    const candidate = closestPointOnSegment(point, track.road[index - 1], track.road[index]);
    if (!closest || candidate.distance < closest.distance) closest = candidate;
  }
  const normalLength = closest?.distance ?? 0;
  return {
    ...closest,
    normalX: normalLength ? (point.x - closest.x) / normalLength : 0,
    normalY: normalLength ? (point.y - closest.y) / normalLength : 0,
  };
}

export function distanceFromRoad(point, track) {
  return closestPointOnRoad(point, track).distance;
}

export function segmentCircleIntersection(start, end, circle, radius) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const fx = start.x - circle.x;
  const fy = start.y - circle.y;
  const a = dx * dx + dy * dy;
  const c = fx * fx + fy * fy - radius * radius;
  if (c <= 0) return { amount: 0, x: start.x, y: start.y };
  if (a === 0) return null;
  const b = 2 * (fx * dx + fy * dy);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const amount = (-b - Math.sqrt(discriminant)) / (2 * a);
  return amount >= 0 && amount <= 1
    ? { amount, x: start.x + dx * amount, y: start.y + dy * amount }
    : null;
}

export function segmentCapsuleIntersection(start, end, capsuleStart, capsuleEnd, radius) {
  const pointAt = (amount) => ({
    x: start.x + (end.x - start.x) * amount,
    y: start.y + (end.y - start.y) * amount,
  });
  const sample = (amount) => {
    const point = pointAt(amount);
    const closest = closestPointOnSegment(point, capsuleStart, capsuleEnd);
    return { amount, point, closest, distanceSquared: closest.distance * closest.distance };
  };
  const radiusSquared = radius * radius;
  const initial = sample(0);
  if (initial.distanceSquared <= radiusSquared) {
    return { amount: 0, x: start.x, y: start.y, closestX: initial.closest.x, closestY: initial.closest.y };
  }

  // Distance to a line segment is convex along a movement segment. Find its
  // minimum, then binary-search the first point where the visible collider is hit.
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const third = (high - low) / 3;
    const left = sample(low + third);
    const right = sample(high - third);
    if (left.distanceSquared <= right.distanceSquared) high -= third;
    else low += third;
  }
  const minimumAmount = (low + high) / 2;
  if (sample(minimumAmount).distanceSquared > radiusSquared) return null;

  low = 0;
  high = minimumAmount;
  for (let iteration = 0; iteration < 28; iteration += 1) {
    const middle = (low + high) / 2;
    if (sample(middle).distanceSquared <= radiusSquared) high = middle;
    else low = middle;
  }
  const hit = sample(high);
  return {
    amount: high,
    x: hit.point.x,
    y: hit.point.y,
    closestX: hit.closest.x,
    closestY: hit.closest.y,
  };
}

/** The fence stands this far outside the road edge; racers are held inside it. */
export const FENCE_OFFSET = 8;
/** A gate reaches this far past the fence so no corner of the corridor slips around it. */
const GATE_OVERHANG = 36;

function roadVertices(road) {
  const first = road[0];
  const last = road[road.length - 1];
  const closed = road.length > 2 && Math.hypot(first.x - last.x, first.y - last.y) < 1e-6;
  return { points: closed ? road.slice(0, -1) : road.slice(), closed };
}

function unit(dx, dy) {
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

/** Build the fence on both sides as one continuous mitered line, bends included. */
export function roadEdgeSegments(track) {
  const { points, closed } = roadVertices(track.road);
  const count = points.length;
  if (count < 2) return [];
  const offset = track.roadWidth / 2 + FENCE_OFFSET;
  const direction = (index) => {
    const from = points[index];
    const to = points[(index + 1) % count];
    return unit(to.x - from.x, to.y - from.y);
  };
  const segmentCount = closed ? count : count - 1;
  const result = [];
  for (const side of [-1, 1]) {
    const offsetVertex = (index) => {
      const previous = closed || index > 0 ? direction((index - 1 + count) % count) : direction(index);
      const next = closed || index < count - 1 ? direction(index) : previous;
      const normalPrevious = { x: -previous.y * side, y: previous.x * side };
      const normalNext = { x: -next.y * side, y: next.x * side };
      const miter = unit(normalPrevious.x + normalNext.x, normalPrevious.y + normalNext.y);
      const scale = offset / Math.max(0.35, miter.x * normalNext.x + miter.y * normalNext.y);
      return { x: points[index].x + miter.x * scale, y: points[index].y + miter.y * scale };
    };
    for (let index = 0; index < segmentCount; index += 1) {
      const start = offsetVertex(index);
      const end = offsetVertex((index + 1) % count);
      const from = points[index];
      const to = points[(index + 1) % count];
      result.push({
        start,
        end,
        side,
        length: Math.hypot(end.x - start.x, end.y - start.y),
        sourceLength: Math.hypot(to.x - from.x, to.y - from.y),
      });
    }
  }
  return result;
}

/** Direction of travel at a road point: the segment's heading, or the bisector at a bend. */
export function roadTangentAt(point, track) {
  let best = null;
  for (let index = 1; index < track.road.length; index += 1) {
    const candidate = closestPointOnSegment(point, track.road[index - 1], track.road[index]);
    if (!best || candidate.distance < best.distance) best = { ...candidate, index: index - 1 };
  }
  const { points, closed } = roadVertices(track.road);
  const count = points.length;
  const segment = (index) => {
    const wrapped = ((index % count) + count) % count;
    const from = points[wrapped];
    const to = points[(wrapped + 1) % count];
    return unit(to.x - from.x, to.y - from.y);
  };
  const lastSegment = closed ? count - 1 : count - 2;
  if (best.amount <= 1e-3 && (closed || best.index > 0)) {
    const previous = segment(best.index - 1);
    const next = segment(best.index);
    return unit(previous.x + next.x, previous.y + next.y);
  }
  if (best.amount >= 1 - 1e-3 && (closed || best.index < lastSegment)) {
    const current = segment(best.index);
    const next = segment(best.index + 1);
    return unit(current.x + next.x, current.y + next.y);
  }
  return segment(best.index);
}

/** Give every checkpoint a gate spanning the whole fenced course, facing the direction of travel. */
export function withCheckpointGates(track) {
  const halfLength = track.roadWidth / 2 + FENCE_OFFSET + GATE_OVERHANG;
  return Object.freeze({
    ...track,
    checkpoints: Object.freeze(track.checkpoints.map((checkpoint) => {
      const tangent = roadTangentAt(checkpoint, track);
      return Object.freeze({
        ...checkpoint,
        gate: Object.freeze({ tangentX: tangent.x, tangentY: tangent.y, halfLength }),
      });
    })),
  });
}

/**
 * True when a move from start to end crosses the checkpoint's gate line going
 * forwards. Half-open (behind -> on/ahead), so one crossing counts exactly once.
 */
export function crossesGate(start, end, checkpoint) {
  const gate = checkpoint.gate;
  const before = (start.x - checkpoint.x) * gate.tangentX + (start.y - checkpoint.y) * gate.tangentY;
  const after = (end.x - checkpoint.x) * gate.tangentX + (end.y - checkpoint.y) * gate.tangentY;
  if (!(before < 0 && after >= 0)) return false;
  const amount = before / (before - after);
  const x = start.x + (end.x - start.x) * amount;
  const y = start.y + (end.y - start.y) * amount;
  const lateral = (x - checkpoint.x) * -gate.tangentY + (y - checkpoint.y) * gate.tangentX;
  return Math.abs(lateral) <= gate.halfLength;
}

/** How far from the road's centre line a racer of this radius may stand: its body touches the fence. */
export function courseLimit(track, radius = 0) {
  return Math.max(0, track.roadWidth / 2 + FENCE_OFFSET - radius);
}

/** Where a racer outside the fence must be put back, or null when it is inside. */
export function confineToCourse(point, track, radius = 0) {
  if (!Array.isArray(track.road) || track.road.length < 2) return null;
  const closest = closestPointOnRoad(point, track);
  const limit = courseLimit(track, radius);
  if (closest.distance <= limit) return null;
  return {
    x: closest.x + closest.normalX * limit,
    y: closest.y + closest.normalY * limit,
    normalX: closest.normalX,
    normalY: closest.normalY,
  };
}

// Station tables are a property of the road, worked out once per road array.
const stationTables = new WeakMap();

/** Cumulative arc length at each road vertex: [0, |v0v1|, ...]. */
function stations(track) {
  const cached = stationTables.get(track.road);
  if (cached) return cached;
  const result = [0];
  for (let index = 1; index < track.road.length; index += 1) {
    const from = track.road[index - 1];
    const to = track.road[index];
    result.push(result[index - 1] + Math.hypot(to.x - from.x, to.y - from.y));
  }
  if (typeof track.road === "object" && track.road) stationTables.set(track.road, result);
  return result;
}

/** The length of one lap of the road's centre line. */
export function roadLength(track) {
  const table = stations(track);
  return table[table.length - 1] || 0;
}

/** How far along the centre line (from the first road vertex) the road point nearest `point` is. */
export function roadStation(point, track) {
  const table = stations(track);
  let best = null;
  for (let index = 1; index < track.road.length; index += 1) {
    const candidate = closestPointOnSegment(point, track.road[index - 1], track.road[index]);
    if (!best || candidate.distance < best.distance) {
      best = { distance: candidate.distance, station: table[index - 1] + (table[index] - table[index - 1]) * candidate.amount };
    }
  }
  return best ? best.station : 0;
}

/** The centre-line point `station` units along the road (wrapping on a closed loop), with its heading. */
export function pointAtStation(track, station) {
  const table = stations(track);
  const total = table[table.length - 1] || 1;
  const wrapped = ((station % total) + total) % total;
  let index = 1;
  while (index < table.length - 1 && table[index] < wrapped) index += 1;
  const from = track.road[index - 1];
  const to = track.road[index];
  const span = table[index] - table[index - 1] || 1;
  const amount = Math.max(0, Math.min(1, (wrapped - table[index - 1]) / span));
  return {
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
    angle: Math.atan2(to.y - from.y, to.x - from.x),
  };
}

export const DEFAULT_TRACK = withCheckpointGates(COURSE);
