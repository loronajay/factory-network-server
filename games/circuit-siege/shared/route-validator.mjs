import { getCellKey, getRoute, getRouteSlots } from "./circuit-board.mjs";
import { deriveMaskFromRouteCell } from "./tile-connectivity.mjs";

export function deriveCanonicalMasksForRoute(route, options = {}) {
  const startDirection = options.startDirection || "N";
  const endDirection = options.endDirection || "S";
  const masksByCellKey = {};

  route.cells.forEach((cell, index) => {
    const previousCell = index > 0 ? route.cells[index - 1] : null;
    const nextCell = index < route.cells.length - 1 ? route.cells[index + 1] : null;
    const mask = deriveMaskFromRouteCell(previousCell, cell, nextCell, {
      startDirection,
      endDirection
    });

    masksByCellKey[getCellKey(cell[0], cell[1])] = mask;
  });

  return masksByCellKey;
}

export function getExpectedMaskForSlot(board, slotId) {
  const slot = board.slotsById[slotId];
  if (!slot) {
    throw new Error(`Unknown slot: ${slotId}`);
  }

  const route = getRoute(board, slot.routeId);
  const canonicalMasks = deriveCanonicalMasksForRoute(route);

  return canonicalMasks[getCellKey(slot.x, slot.y)] || null;
}

export function isRouteComplete(board, routeId, slotPlacements) {
  const route = getRoute(board, routeId);
  if (!route) {
    throw new Error(`Unknown route: ${routeId}`);
  }

  const routeSlots = getRouteSlots(board, routeId);
  const canonicalMasks = deriveCanonicalMasksForRoute(route);

  return routeSlots.every((slot) => {
    const expectedMask = canonicalMasks[getCellKey(slot.x, slot.y)];
    return slotPlacements[slot.slotId] === expectedMask;
  });
}
