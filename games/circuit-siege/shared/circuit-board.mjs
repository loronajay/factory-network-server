function indexById(items, idKey) {
  const map = {};
  for (const item of items) {
    map[item[idKey]] = item;
  }
  return map;
}

export function loadBoardDefinition(rawBoard) {
  if (!rawBoard || typeof rawBoard !== "object") {
    throw new Error("Board definition must be an object.");
  }

  if (!Array.isArray(rawBoard.routes) || rawBoard.routes.length === 0) {
    throw new Error("Board definition must include routes.");
  }

  if (!Array.isArray(rawBoard.repairSlots) || rawBoard.repairSlots.length === 0) {
    throw new Error("Board definition must include repairSlots.");
  }

  const routesById = indexById(rawBoard.routes, "routeId");
  const slotsById = indexById(rawBoard.repairSlots, "slotId");
  const slotsByRouteId = {};

  for (const slot of rawBoard.repairSlots) {
    if (!routesById[slot.routeId]) {
      throw new Error(`Repair slot references unknown route: ${slot.routeId}`);
    }

    if (!slotsByRouteId[slot.routeId]) {
      slotsByRouteId[slot.routeId] = [];
    }

    slotsByRouteId[slot.routeId].push(slot);
  }

  return {
    ...rawBoard,
    routesById,
    slotsById,
    slotsByRouteId
  };
}

export function getRoute(board, routeId) {
  return board.routesById[routeId] || null;
}

export function getRouteSlots(board, routeId) {
  return (board.slotsByRouteId[routeId] || []).slice();
}

export function getCellKey(x, y) {
  return `${x},${y}`;
}
