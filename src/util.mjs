// Pure helpers with no dependency on in-memory state. Safe to unit test in
// isolation and to import from game engines without coupling them to the lobby.
import {
  MAX_LOBBY_PLAYERS,
  DEFAULT_LOBBY_MIN_PLAYERS,
  DEFAULT_LOBBY_MAX_PLAYERS,
} from "./state.mjs";

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function sanitizeRoomGameId(value) {
  const gameId = typeof value === "string" ? value.trim() : "";
  return gameId.slice(0, 64) || "default";
}

export function sanitizeLobbyGameId(value) {
  const gameId = typeof value === "string" ? value.trim() : "";
  return gameId.slice(0, 64) || "default";
}

export function sanitizePenaltyWord(value) {
  const word = typeof value === "string" ? value.trim().toUpperCase() : "";
  const lettersOnly = word.replace(/[^A-Z]/g, "");
  if (lettersOnly.length < 4 || lettersOnly.length > 10) return "ECHO";
  return lettersOnly;
}

// Shared display-name sanitizer used by every lobby-based game engine.
export function sanitizeDisplayName(value, fallback = "Player") {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return (trimmed || fallback).slice(0, 18);
}

export function lobbyPlayerCount(lobby) {
  return lobby?.members?.size || 0;
}

export function sanitizeLobbySettings(settings = {}) {
  const matchType = typeof settings.matchType === "string" ? settings.matchType.trim().slice(0, 32) : "";
  return {
    penaltyWord: sanitizePenaltyWord(settings.penaltyWord || "ECHO"),
    packId: typeof settings.packId === "string" && settings.packId.trim() ? settings.packId.trim().slice(0, 32) : "pack_01",
    runFormat: typeof settings.runFormat === "string" && settings.runFormat.trim() ? settings.runFormat.trim().slice(0, 32) : "canon_10_stage",
    matchType: matchType || "default",
    // Whether the match counts toward a competitive record. It lives in lobby
    // settings rather than in a game's own message because matchmaking compares
    // settings: two queues that disagree on the stakes must never be paired, and
    // sameLobbySettings gets that for free from a primitive field. A game that
    // never sends it stays false on both sides and is unaffected.
    ranked: settings.ranked === true,
    protocolVersion: Number.isFinite(Number(settings.protocolVersion)) ? Math.max(1, Math.floor(Number(settings.protocolVersion))) : 1,
  };
}

export function sanitizeLobbyIdentity(identity = {}) {
  if (!identity || typeof identity !== "object") return null;
  const displayName = sanitizeDisplayName(identity.displayName || "", "");
  const playerId = typeof identity.playerId === "string" ? identity.playerId.trim() : "";
  if (!displayName && !playerId) return null;
  return {
    playerId,
    displayName,
  };
}

export function sanitizeLobbyLimits(minPlayers, maxPlayers) {
  const max = clampInt(maxPlayers, 2, MAX_LOBBY_PLAYERS, DEFAULT_LOBBY_MAX_PLAYERS);
  const min = clampInt(minPlayers, 2, max, Math.min(DEFAULT_LOBBY_MIN_PLAYERS, max));
  return { minPlayers: min, maxPlayers: max };
}
