const clamp = (value, min, max, fallback) => value !== null && value !== "" && Number.isFinite(Number(value))
  ? Math.min(max, Math.max(min, Number(value)))
  : fallback;

/** Convert durable farm values into the narrow race modifiers used by the cabinet. */
export function racePetProfile(values = {}) {
  const speed = clamp(values.speed, 0, 100, 50);
  const strength = clamp(values.strength, 0, 100, 50);
  const size = clamp(values.size, 0.62, 1.12, 1);

  return Object.freeze({
    speed,
    strength,
    size,
    speedMultiplier: Number((0.9 + speed / 500).toFixed(4)),
    impactRetention: Number((0.52 + strength * 0.003).toFixed(4)),
    mudGrip: Number((0.65 + strength * 0.002).toFixed(4)),
    gatePower: Number((0.65 + strength * 0.004).toFixed(4)),
    radius: Number((12 * size).toFixed(3)),
  });
}
