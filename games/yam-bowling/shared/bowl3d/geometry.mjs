// Physical room and pin dimensions adapted from the supplied 3D Bowl V6.
// Both the meshes and collision shapes read these dimensions.
export const LANE_TOP = .15;
export const PIN_COM = .69;
export const BALL_RADIUS = .52;
export const RELEASE_Z = 7.2;
export const LANE_LENGTH = 84;
export const HEAD_Z = RELEASE_Z - LANE_LENGTH;
export const SHOT_X_SCALE = 4.65;
export const GUTTER_CAPTURE_X = 3.08;
export const DECK_END_Z = HEAD_Z - 4.75;
export const PIT_Z = HEAD_Z - 4.95;
export const LANE_START_Z = 10.2;
export const LANE_SURFACE_LENGTH = LANE_START_Z - DECK_END_Z;
export const LANE_CENTER_Z = (LANE_START_Z + DECK_END_Z) / 2;
export const ROOM_LENGTH = 13 - (HEAD_Z - 7.95);
export const ROOM_CENTER_Z = 13 - ROOM_LENGTH / 2;
export const deckZ = offset => HEAD_Z + offset;
export const PIN_PROFILE = [[0,0],[.16,.018],[.205,.055],[.235,.16],[.285,.36],[.292,.48],[.265,.64],[.21,.80],[.155,.94],[.13,1.08],[.14,1.20],[.175,1.32],[.205,1.43],[.20,1.54],[.165,1.64],[.095,1.73],[0,1.78]];
export const PIN_SHAPES = [[.25,.215],[.46,.285],[.68,.245],[.88,.175],[1.08,.135],[1.31,.17],[1.49,.19],[1.63,.145]];
export const PIN_POSITIONS = Array.from({ length: 4 }, (_, row) =>
  Array.from({ length: row + 1 }, (_, col) => [(col - row / 2) * 1.4, HEAD_Z - row * 1.4 * .8660254])).flat();
export const ROOM_BOXES = [
  { size: [6,.3,LANE_SURFACE_LENGTH], pos: [0,0,LANE_CENTER_Z], surface: 'lane' },
  ...[-1,1].flatMap(side => [
    { size: [.75,.18,LANE_SURFACE_LENGTH], pos: [side*3.38,-.16,LANE_CENTER_Z], surface: 'gutter' },
    { size: [.16,1,LANE_SURFACE_LENGTH], pos: [side*3.82,.28,LANE_CENTER_Z], surface: 'gutter' },
    { size: [4.5,.2,ROOM_LENGTH], pos: [side*6,-.55,ROOM_CENTER_Z], surface: 'floor' },
    { size: [.3,9,ROOM_LENGTH], pos: [side*7.8,4,ROOM_CENTER_Z], surface: 'wall' },
    { size: [.22,2.4,8.1], pos: [side*3.63,1.15,deckZ(-1.1)], surface: 'gutter' },
    { size: [.25,3,4.2], pos: [side*3.64,.05,deckZ(-6.85)], surface: 'gutter' },
  ]),
  { size: [6,.2,8], pos: [0,-.55,8.2], surface: 'floor' },
  { size: [7.25,.22,4.3], pos: [0,-1.42,deckZ(-6.8)], surface: 'gutter' },
  { size: [7.5,4,.28], pos: [0,.55,deckZ(-8.95)], surface: 'gutter' },
];
export const normalizedZ = z => (RELEASE_Z - z) / (RELEASE_Z - HEAD_Z) * .86;
export const worldZ = z => RELEASE_Z - z / .86 * (RELEASE_Z - HEAD_Z);

// Cannon derives a compound body's inertia from its world AABB, so the pin --
// eight spheres on a stick -- is billed as a solid 0.57 x 1.78 x 0.57 block and
// resists rotation about a quarter more than a pin does. Integrate the real
// silhouette instead: a uniform solid of revolution around PIN_PROFILE, taken
// about the body's own centre of mass, per unit of pin mass.
export const PIN_INERTIA_PER_MASS = (() => {
  const steps = 4000, dy = 1.78 / steps;
  const radiusAt = y => {
    for (let i = 1; i < PIN_PROFILE.length; i += 1) {
      const [r0, y0] = PIN_PROFILE[i - 1], [r1, y1] = PIN_PROFILE[i];
      if (y <= y1) return r0 + (r1 - r0) * (y - y0) / (y1 - y0);
    }
    return 0;
  };
  let volume = 0, transverse = 0, vertical = 0;
  for (let i = 0; i < steps; i += 1) {
    const y = (i + .5) * dy, r = radiusAt(y), slice = Math.PI * r * r * dy;
    volume += slice;
    transverse += slice * (r * r / 4 + (y - PIN_COM) ** 2);
    vertical += slice * (r * r / 2);
  }
  return [transverse / volume, vertical / volume, transverse / volume];
})();
