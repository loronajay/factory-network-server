import { scratchToGamePoint } from "./coordinates.js";

export const POOP_LANDING_Y = 674;
export const POOP_FALL_SPEED = 15;
export const POOP_BACKSIDE_OFFSET_X = 35;
export const POOP_BACKSIDE_OFFSET_Y = 150;
export const POOP_RENDER_SCALE = 2;
export const SPLAT_TICKS = 45;

export function createPoopState() {
  return {
    phase: "inactive",
    x: 0,
    y: 0,
    splatTicks: 0,
  };
}

export function spawnPoopFromPlayer(player) {
  const rearDirection = player.facing === "left" ? 1 : -1;
  const anchor = scratchToGamePoint(player.x, player.y);

  return {
    phase: "airborne",
    x: anchor.x + rearDirection * POOP_BACKSIDE_OFFSET_X,
    y: anchor.y - POOP_BACKSIDE_OFFSET_Y,
    splatTicks: 0,
  };
}

export function isPoopHitboxActive(poop) {
  return poop.phase === "airborne";
}

export function updatePoop(poop) {
  if (poop.phase === "splat") {
    const splatTicks = poop.splatTicks + 1;
    if (splatTicks >= SPLAT_TICKS) return createPoopState();
    return { ...poop, splatTicks };
  }

  if (poop.phase !== "airborne") return poop;

  const nextY = poop.y + POOP_FALL_SPEED;
  if (nextY >= POOP_LANDING_Y) {
    return {
      ...poop,
      phase: "splat",
      y: POOP_LANDING_Y,
      splatTicks: 0,
    };
  }

  return {
    ...poop,
    y: nextY,
  };
}
