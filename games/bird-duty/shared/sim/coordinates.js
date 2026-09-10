export const SCRATCH_STAGE = Object.freeze({
  width: 666,
  height: 368,
});

export const GAME_STAGE = Object.freeze({
  width: 1280,
  height: 720,
});

export function scratchToCanvasPoint(x, y, stage = SCRATCH_STAGE) {
  return {
    x: stage.width / 2 + Number(x || 0),
    y: stage.height / 2 - Number(y || 0),
  };
}

export function canvasToScratchPoint(x, y, stage = SCRATCH_STAGE) {
  return {
    x: Number(x || 0) - stage.width / 2,
    y: stage.height / 2 - Number(y || 0),
  };
}

export function costumeDrawRect({
  x = 0,
  y = 0,
  width,
  height,
  rotationCenterX = 0,
  rotationCenterY = 0,
  size = 100,
  stage = SCRATCH_STAGE,
}) {
  const scale = Number(size || 100) / 100;
  const anchor = scratchToCanvasPoint(x, y, stage);

  return {
    x: anchor.x - rotationCenterX * scale,
    y: anchor.y - rotationCenterY * scale,
    width: width * scale,
    height: height * scale,
  };
}

export function scratchToGamePoint(x, y, stage = GAME_STAGE) {
  return {
    x: stage.width / 2 + Number(x || 0),
    y: stage.height / 2 - Number(y || 0),
  };
}
