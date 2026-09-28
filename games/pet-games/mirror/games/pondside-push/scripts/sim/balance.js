const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const SPECIES_RADII = Object.freeze({
  "pet.corgi": 0.45, "pet.duck": 0.35, "pet.red-panda": 0.45, "pet.platypus": 0.4,
  "pet.hippo": 0.85, "pet.rhino": 0.9, "pet.bat": 0.35, "pet.shark": 0.8,
  "pet.anglerfish": 0.4, "pet.jellyfish": 0.4,
});

export function movementProfile(stats = {}, speciesId = "pet.corgi") {
  const speed = clamp(Number(stats.speed) || 0, 0, 100);
  const size = clamp(Number(stats.size) || 1, 0.6, 1.2);
  return Object.freeze({
    maxSpeed: 180 + speed * 0.4,
    acceleration: 290,
    momentumBuildSeconds: 1.1,
    radius: (SPECIES_RADII[speciesId] ?? 0.45) * 42 * size,
  });
}

export function bumpPowerForSpeed(currentSpeed, stats = {}) {
  const speed = clamp(Number(currentSpeed) || 0, 0, 260);
  const strength = clamp(Number(stats.strength) || 0, 0, 100);
  return (165 + speed * 1.55) * (0.95 + strength / 1000);
}
