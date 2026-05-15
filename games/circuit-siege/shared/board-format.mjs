function clonePoint(point) {
  return [Number(point[0]), Number(point[1])];
}

export function expandOrthogonalPointsToCells(points = []) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error("Route points must include at least two coordinates.");
  }

  const cells = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const [startX, startY] = clonePoint(points[index]);
    const [endX, endY] = clonePoint(points[index + 1]);

    if (!Number.isFinite(startX) || !Number.isFinite(startY) || !Number.isFinite(endX) || !Number.isFinite(endY)) {
      throw new Error("Route points must contain numeric coordinates.");
    }

    const isVertical = startX === endX;
    const isHorizontal = startY === endY;

    if (!isVertical && !isHorizontal) {
      throw new Error(`Route segment must be orthogonal: (${startX},${startY}) -> (${endX},${endY})`);
    }

    const stepX = endX === startX ? 0 : endX > startX ? 1 : -1;
    const stepY = endY === startY ? 0 : endY > startY ? 1 : -1;
    const distance = Math.max(Math.abs(endX - startX), Math.abs(endY - startY));

    for (let offset = 0; offset <= distance; offset += 1) {
      if (index > 0 && offset === 0) {
        continue;
      }

      cells.push([
        startX + stepX * offset,
        startY + stepY * offset
      ]);
    }
  }

  return cells;
}

// ─── Compact board format ────────────────────────────────────────────────────
// Authored format: only blue routes, inline slot specs, red side derived.
// Call expandCompactBoard(raw) then pass the result to loadBoardDefinition.

import { deriveMaskFromRouteCell } from "./tile-connectivity.mjs";

function computeExpectedMask(path, x, y) {
  const cells = expandOrthogonalPointsToCells(path);
  const index = cells.findIndex(([cx, cy]) => cx === x && cy === y);
  if (index < 0) return null;
  const prev = index > 0 ? cells[index - 1] : null;
  const next = index < cells.length - 1 ? cells[index + 1] : null;
  return deriveMaskFromRouteCell(prev, cells[index], next);
}

function padIndex(n) {
  return String(n).padStart(2, "0");
}

function buildRouteId(owner, index) {
  return `${owner}_route_${padIndex(index)}`;
}

function buildSourceId(owner, index) {
  return `${owner}_source_${padIndex(index)}`;
}

function buildTerminalId(owner, index) {
  return `${owner}_terminal_${padIndex(index)}`;
}

function mirrorRouteIndex(n) {
  return 11 - n;
}

function mirrorX(x, cols) {
  return cols - 1 - x;
}

function expandSlots(routeId, owner, terminalType, slotSpecs, routePath, cols, isMirror) {
  return slotSpecs.map(([specX, specY, slotType], i) => {
    const x = isMirror ? mirrorX(specX, cols) : specX;
    return {
      slotId: `${routeId}_rp_${i + 1}`,
      routeId,
      owner,
      x,
      y: specY,
      slotType,
      terminalType,
      expectedMask: computeExpectedMask(routePath, x, specY)
    };
  });
}

export function expandCompactBoard(compact) {
  if (!compact || typeof compact !== "object") {
    throw new Error("Compact board must be an object.");
  }

  const { grid, routes: compactRoutes } = compact;

  if (!grid || typeof grid !== "object") {
    throw new Error("Compact board must include a grid object with cols, rows, and sideCols.");
  }

  const { cols, rows, sideCols } = grid;

  if (!Number.isFinite(cols) || !Number.isFinite(rows) || !Number.isFinite(sideCols)) {
    throw new Error("Compact board grid must have numeric cols, rows, and sideCols.");
  }

  if (!Array.isArray(compactRoutes) || compactRoutes.length === 0) {
    throw new Error("Compact board must include a non-empty routes array.");
  }

  const blueRoutes = [];
  const redRoutes = [];
  const blueSlots = [];
  const redSlots = [];
  const blueDamageTerminals = [];
  const redDamageTerminals = [];
  const blueSourceToTerminal = {};

  for (let i = 0; i < compactRoutes.length; i++) {
    const cr = compactRoutes[i];
    const blueIndex = i + 1;
    const redIndex = mirrorRouteIndex(blueIndex);
    const redSrcIndex = mirrorRouteIndex(cr.src);
    const redTermIndex = mirrorRouteIndex(cr.term);

    const blueRouteId = buildRouteId("blue", blueIndex);
    const redRouteId = buildRouteId("red", redIndex);
    const slotSpecs = Array.isArray(cr.slots) ? cr.slots : [];

    blueRoutes.push({
      routeId: blueRouteId,
      owner: "blue",
      routeIndex: blueIndex,
      sourceIndex: cr.src,
      sourceId: buildSourceId("blue", cr.src),
      terminalIndex: cr.term,
      terminalId: buildTerminalId("blue", cr.term),
      terminalType: cr.type,
      mirrorRouteId: redRouteId,
      points: cr.path
    });

    const redPath = cr.path.map(([x, y]) => [mirrorX(x, cols), y]);

    redRoutes.push({
      routeId: redRouteId,
      owner: "red",
      routeIndex: redIndex,
      sourceIndex: redSrcIndex,
      sourceId: buildSourceId("red", redSrcIndex),
      terminalIndex: redTermIndex,
      terminalId: buildTerminalId("red", redTermIndex),
      terminalType: cr.type,
      mirrorRouteId: blueRouteId,
      points: redPath
    });

    blueSlots.push(...expandSlots(blueRouteId, "blue", cr.type, slotSpecs, cr.path, cols, false));
    redSlots.push(...expandSlots(redRouteId, "red", cr.type, slotSpecs, redPath, cols, true));

    if (cr.type === "damage") {
      blueDamageTerminals.push(cr.term);
      redDamageTerminals.push(redTermIndex);
    }

    blueSourceToTerminal[String(cr.src)] = cr.term;
  }

  const damageCount = blueDamageTerminals.length;

  return {
    title: compact.title,
    version: compact.version,
    mapId: compact.mapId,
    cols,
    rows,
    sideCols,
    centerWallColumn: sideCols,
    sourceCountPerSide: compactRoutes.length,
    terminalCountPerSide: compactRoutes.length,
    damageTerminalsPerSide: damageCount,
    dudTerminalsPerSide: compactRoutes.length - damageCount,
    blueDamageTerminals,
    redDamageTerminals,
    blueSourceToTerminal,
    notes: Array.isArray(compact.notes) ? compact.notes.slice() : undefined,
    routes: [...blueRoutes, ...redRoutes],
    repairSlots: [...blueSlots, ...redSlots]
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export function deriveRouteCells(route) {
  if (Array.isArray(route?.cells) && route.cells.length > 0) {
    return route.cells.map(clonePoint);
  }

  if (Array.isArray(route?.points) && route.points.length > 1) {
    return expandOrthogonalPointsToCells(route.points);
  }

  throw new Error(`Route must include cells or at least two points: ${route?.routeId || "unknown route"}`);
}
