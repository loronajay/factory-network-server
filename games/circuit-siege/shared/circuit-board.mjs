function indexById(items, idKey) {
  const map = {};
  for (const item of items) {
    map[item[idKey]] = item;
  }
  return map;
}

function buildRouteOwnershipByCell(routes) {
  const map = new Map();

  for (const route of routes) {
    for (const [x, y] of route.cells || []) {
      const key = `${x},${y}`;
      const owners = map.get(key) || [];
      owners.push(route.routeId);
      map.set(key, owners);
    }
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
  const routeOwnershipByCell = buildRouteOwnershipByCell(rawBoard.routes);

  for (const slot of rawBoard.repairSlots) {
    if (!routesById[slot.routeId]) {
      throw new Error(`Repair slot references unknown route: ${slot.routeId}`);
    }

    const routeOwners = routeOwnershipByCell.get(`${slot.x},${slot.y}`) || [];
    if (routeOwners.length !== 1 || routeOwners[0] !== slot.routeId) {
      throw new Error(`Repair slot must sit on a cell owned only by its own route: ${slot.slotId}`);
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
