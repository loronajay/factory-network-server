// Cabinet-local tuning. Keep table dimensions shared by physics and presentation.
export const W = 10, L = 16, GOAL = 3.15, RAIL = .38;
export const PUCK_R = .43, CONTACT_R = PUCK_R + .73;
export const X_LIMIT = W / 2 - PUCK_R - .015;
export const Z_RAIL_LIMIT = L / 2 - PUCK_R - .015;
export const GOAL_CLEAR = Math.max(.25, GOAL / 2 - PUCK_R - .025);
export const GOAL_CAPTURE_Z = L / 2 + .42;
export const FIXED_DT = 1 / 240;
export const PLAYER_MAX_SPEED = 38, PLAYER_TRACK_TIME = .022;
export const ARENA_IDS = Object.freeze(['hyper_arcade', 'competition_circuit', 'park_jam', 'skyline_rooftop']);
export const DEFAULT_SETTINGS = Object.freeze({ mode: 'cpu', playerColor: '#a14848', cpuDifficulty: 1, targetScore: 7, arenaId: 'hyper_arcade', muted: false });
