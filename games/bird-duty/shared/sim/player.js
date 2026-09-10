export const PLAYER_START = Object.freeze({
  x: 0,
  y: 35,
});

export const PLAYER_BOUNDS = Object.freeze({
  minX: -375,
  maxX: 375,
});

export const PLAYER_SPEED = 5;
export const PLAYER_FRAME_TICKS = 8;
export const PLAYER_RENDER_SCALE = 3;

export const PLAYER_FRAME_FILES = Object.freeze([
  "assets/scratch/pngs/white-game-1.png",
  "assets/scratch/pngs/white-game-2.png",
  "assets/scratch/pngs/white-game-3.png",
]);

export function createPlayerState() {
  return {
    x: PLAYER_START.x,
    y: PLAYER_START.y,
    facing: "right",
    animationTick: 0,
  };
}

export function clampPlayerX(x) {
  return Math.max(PLAYER_BOUNDS.minX, Math.min(PLAYER_BOUNDS.maxX, x));
}

export function getPlayerFrameIndex(animationTick, frameCount = PLAYER_FRAME_FILES.length) {
  const safeFrameCount = Math.max(1, frameCount | 0);
  const safeTick = Math.max(0, animationTick | 0);
  return Math.floor(safeTick / PLAYER_FRAME_TICKS) % safeFrameCount;
}

export function updatePlayer(player, input = {}) {
  const moveLeft = Boolean(input.left);
  const moveRight = Boolean(input.right);
  let dx = 0;

  if (moveLeft && !moveRight) dx = -PLAYER_SPEED;
  if (moveRight && !moveLeft) dx = PLAYER_SPEED;

  return {
    ...player,
    x: clampPlayerX(player.x + dx),
    facing: dx < 0 ? "left" : dx > 0 ? "right" : player.facing,
    animationTick: player.animationTick + 1,
  };
}
