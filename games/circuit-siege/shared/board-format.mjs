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

export function deriveRouteCells(route) {
  if (Array.isArray(route?.cells) && route.cells.length > 0) {
    return route.cells.map(clonePoint);
  }

  if (Array.isArray(route?.points) && route.points.length > 1) {
    return expandOrthogonalPointsToCells(route.points);
  }

  throw new Error(`Route must include cells or at least two points: ${route?.routeId || "unknown route"}`);
}
