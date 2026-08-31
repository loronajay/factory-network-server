import { SHOT_X_SCALE, LANE_LENGTH, HEAD_Z, DECK_END_Z, GUTTER_CAPTURE_X,
  PIN_POSITIONS, normalizedZ, worldZ } from './geometry.mjs';

// Lane travel shares Arcade's shot model. Cannon takes over at first pin
// contact, so neither the guide nor the lane controller can undo a deflection.
export function lanePointForShot(physics, shot, z) {
  return { x: physics.trajectoryX(z, shot) * SHOT_X_SCALE, z: worldZ(z) };
}

export function launchForShot(physics, shot) {
  const speed = 10.8 + physics.ballSpeedForShot(shot) * 13.5;
  return { x: lanePointForShot(physics, shot, 0).x,
    vx: physics.trajectoryDerivative(0, shot) * SHOT_X_SCALE * .86 / LANE_LENGTH * speed, speed };
}

export function createAimPreview(physics, shot, pins = []) {
  const breakZ = physics.hookBreakpointForPower(shot.power);
  const targetWorldZ = pins.filter(p => p.standing).reduce((z, p) => Math.max(z, PIN_POSITIONS[p.id - 1][1]), -Infinity);
  const targetZ = normalizedZ(Number.isFinite(targetWorldZ) ? targetWorldZ : HEAD_Z);
  const endZ = normalizedZ(DECK_END_Z);
  // Include exact semantic points as well as regular samples, so markers sit
  // on the line and the two colored sections meet without a gap.
  const samples = [...new Set([0, breakZ, targetZ, endZ,
    ...Array.from({ length: 180 }, (_, i) => endZ * i / 180)])].sort((a, b) => a - b);
  const preview = { skid: [], hook: [], breakpoint: null, target: null, gutter: null };
  let previousZ = 0;
  for (let z of samples) {
    let point = lanePointForShot(physics, shot, z);
    if (Math.abs(point.x) >= GUTTER_CAPTURE_X) {
      let lo = previousZ, hi = z;
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        if (Math.abs(lanePointForShot(physics, shot, mid).x) < GUTTER_CAPTURE_X) lo = mid;
        else hi = mid;
      }
      z = hi; point = lanePointForShot(physics, shot, z);
      point.x = Math.sign(point.x) * GUTTER_CAPTURE_X;
      preview.gutter = { ...point, side: Math.sign(point.x) };
    }
    if (z <= breakZ) preview.skid.push(point);
    if (z >= breakZ) preview.hook.push(point);
    if (z === breakZ) preview.breakpoint = point;
    if (z === targetZ) preview.target = point;
    if (preview.gutter) break;
    previousZ = z;
  }
  return preview;
}
