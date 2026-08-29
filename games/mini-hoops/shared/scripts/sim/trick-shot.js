// Reusable sandbox-piece records.
//
// This module deliberately knows nothing about either editor's DOM or storage.
// The Lab and HORSE both consume these records, so a saved layout and a standing
// HORSE shot describe the same physical tools with the same validation.

import { DEFAULT_BALL, ballById } from "../assets/ball-catalog.js";
import { DEFAULT_LOCATION, locationById } from "../assets/location-catalog.js";
import { defaultTrickShotTarget, normalizeTrickShotTarget } from "./trick-shot-target.js";

export const BOARD_PIECE = "board";
export const SPRING_PIECE = "spring";
export const CANNON_PIECE = "cannon";
export const SANDBOX_PIECE_TYPES = Object.freeze([BOARD_PIECE, SPRING_PIECE, CANNON_PIECE]);
export const MAX_SANDBOX_PIECES = 24;
// Bumped when `target` joined the record. Nothing branches on it — a v1 layout
// simply normalizes with the default target, which is the still wall hoop it was
// authored against, so there is no migration to write.
export const TRICK_SHOT_VERSION = 2;

/**
 * How thick a rebound pad is, front to back, in world units.
 *
 * A PAD IS A BLOCK, NOT A PLATE, AND THAT IS A VISIBILITY DECISION AS MUCH AS A
 * PHYSICAL ONE. This was 0.055 — about 14 screen pixels at mid-room — and a
 * plate that thin has one fatal property in a perspective room: turn it toward
 * edge-on and it disappears. Measured, a 0.48 pad at z = 0.5 went from a 127px
 * silhouette at yaw 0 to SEVENTEEN PIXELS at yaw 90, while its drawn height grew
 * by a third on the way. Nothing about that is a projection bug — a flat square
 * really does foreshorten like that — but a tool the player is arranging by hand
 * must not evaporate as they arrange it, and "it changed size when I rotated it"
 * is exactly what a shape doing that reads as.
 *
 * At 0.13 the same turn leaves a solid slab standing edge-on, its side faces lit
 * from the left like everything else in the room, so the turn reads as a TURN.
 * The collider thickens with it — this is the half-depth `sim/trick-shot-physics.js`
 * builds its box from and the depth `render/trick-shot.js` builds its faces from,
 * one number for both, so the block that is drawn is the block that is hit.
 *
 * It stays under the ball's own radius (0.078) on purpose: a slab thicker than
 * the ball starts to read as a wall rather than a bumper.
 */
export const BOARD_PAD_THICKNESS = 0.13;

export const isPadPiece = (piece) => piece?.type === BOARD_PIECE || piece?.type === SPRING_PIECE;

export const PIECE_BOUNDS = Object.freeze({
  x: Object.freeze([-0.9, 0.9]),
  y: Object.freeze([0.12, 1.58]),
  z: Object.freeze([0.08, 0.94]),
});

const clamp = (value, min, max, fallback) => {
  const numeric = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(numeric) ? numeric : fallback));
};

const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

export function normalizePieceId(value, fallback = "piece") {
  const safe = String(value || fallback).trim().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48);
  return safe || fallback;
}

export function normalizeShotName(value) {
  const safe = String(value || "").replace(/\s+/g, " ").trim().slice(0, 40);
  return safe || "Untitled Trick Shot";
}

export function normalizeAngle(value, fallback = 0) {
  const angle = finite(value, fallback);
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** Create one validated piece record from player-authored or stored data. */
export function createSandboxPiece(type, input = {}, fallbackId = `${type || "piece"}-1`) {
  if (!SANDBOX_PIECE_TYPES.includes(type)) return null;
  const common = {
    id: normalizePieceId(input.id, fallbackId),
    type,
    x: clamp(input.x, ...PIECE_BOUNDS.x, 0),
    y: clamp(input.y, ...PIECE_BOUNDS.y, type === CANNON_PIECE ? 0.34 : 0.72),
    z: clamp(input.z, ...PIECE_BOUNDS.z, type === CANNON_PIECE ? 0.32 : 0.55),
  };

  if (isPadPiece(common)) {
    const pad = {
      ...common,
      yaw: normalizeAngle(input.yaw, 0),
      angle: clamp(input.angle, -Math.PI * 0.44, Math.PI * 0.44, 0),
      // `length` is retained in the saved schema, but now means both sides of
      // a square rebound pad. Old layouts therefore load as useful pads rather
      // than needing a storage migration.
      length: clamp(input.length, 0.28, 0.68, 0.48),
    };
    return type === SPRING_PIECE
      ? { ...pad, speed: clamp(input.speed, 2.5, 7.5, 5.8) }
      : { ...pad, restitution: clamp(input.restitution, 0.45, 1.12, 0.88) };
  }

  return {
    ...common,
    yaw: normalizeAngle(input.yaw, 0),
    pitch: clamp(input.pitch, Math.PI / 36, Math.PI * 0.44, Math.PI / 4),
    speed: clamp(input.speed, 2.5, 7.5, 5.4),
    delay: clamp(input.delay, 0.25, 2, 0.5),
  };
}

/** Validate a bounded, uniquely identified list of player-authored tools. */
export function normalizeSandboxPieces(input = []) {
  const pieces = [];
  const ids = new Set();
  for (const [index, source] of (Array.isArray(input) ? input : []).entries()) {
    if (pieces.length >= MAX_SANDBOX_PIECES) break;
    if (!SANDBOX_PIECE_TYPES.includes(source?.type)) continue;
    const piece = createSandboxPiece(source.type, source, `${source.type}-${index + 1}`);
    if (!piece || ids.has(piece.id)) continue;
    ids.add(piece.id);
    pieces.push(piece);
  }
  return pieces;
}

/** A storage-safe Trick Shot Lab layout. It intentionally has no HORSE fields. */
export function normalizeTrickShot(input = {}) {
  return {
    version: TRICK_SHOT_VERSION,
    id: normalizePieceId(input.id, ""),
    name: normalizeShotName(input.name),
    locationId: locationById(input.locationId || DEFAULT_LOCATION).id,
    ballId: ballById(input.ballId || DEFAULT_BALL).id,
    // What the shot is aimed at, and how that target moves. A record saved
    // before targets existed has none, and takes the still wall hoop it was
    // authored against — see `TRICK_SHOT_VERSION`.
    target: input.target ? normalizeTrickShotTarget(input.target) : defaultTrickShotTarget(),
    pieces: normalizeSandboxPieces(input.pieces),
    createdAt: Math.max(0, finite(input.createdAt, 0)),
    updatedAt: Math.max(0, finite(input.updatedAt, 0)),
  };
}

/**
 * Orthonormal frame for the rebound pad's square face.
 *
 * Yaw and tilt describe the direction the face points, matching the launcher's
 * direction controls. `right` and `up` lie on the impact face; `normal` is the
 * direction a centred hit reflects along. Rendering and collision share this
 * exact frame so the painted surface is always the physical surface.
 */
export function boardFrame(board) {
  const yaw = board.yaw;
  const tilt = board.angle;
  const horizontal = Math.cos(tilt);
  return {
    normal: {
      x: Math.sin(yaw) * horizontal,
      y: Math.sin(tilt),
      z: Math.cos(yaw) * horizontal,
    },
    right: {
      x: Math.cos(yaw),
      y: 0,
      z: -Math.sin(yaw),
    },
    up: {
      x: -Math.sin(yaw) * Math.sin(tilt),
      y: Math.cos(tilt),
      z: -Math.cos(yaw) * Math.sin(tilt),
    },
  };
}

export function cannonDirection(cannon) {
  const horizontal = Math.cos(cannon.pitch);
  return {
    x: Math.sin(cannon.yaw) * horizontal,
    y: Math.sin(cannon.pitch),
    z: Math.cos(cannon.yaw) * horizontal,
  };
}
