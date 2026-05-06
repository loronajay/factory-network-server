const OPENINGS_BY_MASK = {
  EW: ["E", "W"],
  NS: ["N", "S"],
  NE: ["N", "E"],
  ES: ["E", "S"],
  SW: ["S", "W"],
  NW: ["N", "W"]
};

const OPPOSITE_DIRECTION = {
  N: "S",
  E: "W",
  S: "N",
  W: "E"
};

function keyForDirections(directionA, directionB) {
  return [directionA, directionB].slice().sort().join("");
}

const MASK_BY_DIRECTIONS = Object.fromEntries(
  Object.entries(OPENINGS_BY_MASK).map(([mask, directions]) => [keyForDirections(directions[0], directions[1]), mask])
);

export function getMaskOpenings(mask) {
  const openings = OPENINGS_BY_MASK[mask];
  if (!openings) {
    throw new Error(`Unknown mask: ${mask}`);
  }

  return openings.slice();
}

export function directionFromTo(fromCell, toCell) {
  const dx = toCell[0] - fromCell[0];
  const dy = toCell[1] - fromCell[1];

  if (dx === 1 && dy === 0) return "E";
  if (dx === -1 && dy === 0) return "W";
  if (dx === 0 && dy === 1) return "S";
  if (dx === 0 && dy === -1) return "N";

  throw new Error(`Cells are not orthogonally adjacent: ${JSON.stringify(fromCell)} -> ${JSON.stringify(toCell)}`);
}

export function getMaskForDirections(directionA, directionB) {
  const mask = MASK_BY_DIRECTIONS[keyForDirections(directionA, directionB)];
  if (!mask) {
    throw new Error(`No mask for directions ${directionA} and ${directionB}`);
  }

  return mask;
}

export function deriveMaskFromRouteCell(previousCell, currentCell, nextCell, options = {}) {
  const startDirection = options.startDirection || "N";
  const endDirection = options.endDirection || "S";

  const directionA = previousCell
    ? directionFromTo(currentCell, previousCell)
    : startDirection;
  const directionB = nextCell
    ? directionFromTo(currentCell, nextCell)
    : endDirection;

  return getMaskForDirections(directionA, directionB);
}

export function masksConnect(maskA, directionFromA, maskB) {
  const openingsA = getMaskOpenings(maskA);
  const openingsB = getMaskOpenings(maskB);
  const requiredOnB = OPPOSITE_DIRECTION[directionFromA];

  return openingsA.includes(directionFromA) && openingsB.includes(requiredOnB);
}
