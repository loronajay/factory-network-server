import { adjudicateMiniHoopsShot } from "./mini-hoops-adjudicator.mjs";

export const MINI_HOOPS_GAME_ID = "mini-hoops";
export const MINI_HOOPS_PROTOCOL_VERSION = 1;
export const MINI_HOOPS_RECONNECT_GRACE_MS = 30_000;

const MODES = new Set(["still", "horizontal", "vertical", "circle", "pendulum", "figure8", "cross", "wander"]);
const DURATIONS = new Set([30, 60]);
const LOCATIONS = new Set(["bedroom", "warehouse", "police", "detention", "cubicle", "rec-hall", "school-gym", "fieldhouse"]);
const BALLS = new Set(["basketball", "paper", "bowling-ball", "snowball"]);

function clean(value, max, fallback = "") {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, max);
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function normalizeMiniHoopsConfig(settings = {}) {
  const duration = Number(settings.duration);
  return {
    modeId: MODES.has(settings.modeId) ? settings.modeId : "still",
    duration: DURATIONS.has(duration) ? duration : 30,
    locationId: LOCATIONS.has(settings.locationId) ? settings.locationId : "bedroom",
    ballId: BALLS.has(settings.ballId) ? settings.ballId : "basketball",
    protocolVersion: MINI_HOOPS_PROTOCOL_VERSION,
  };
}

export function sanitizeMiniHoopsShot(value = {}) {
  return {
    power: clamp(value.power, 0, 1, 0),
    aimX: clamp(value.aimX, 320, 640, 480),
    aimY: 224,
    loft: clamp(value.loft, 0, 1, 1),
    expectedShotNumber: Math.max(0, Math.floor(clamp(value.expectedShotNumber, 0, 10_000, 0))),
  };
}

function playerFromLobby(lobby, clientId, index) {
  const profile = lobby?.memberProfiles?.get(clientId) || {};
  return {
    id: clientId,
    accountPlayerId: clean(profile.playerId, 64),
    name: clean(profile.displayName, 24, `Player ${index + 1}`),
    score: 0,
    shots: 0,
    made: 0,
    bestStreak: 0,
    streak: 0,
    connected: true,
  };
}

export function createMiniHoopsMatchState(lobby, startAt) {
  const config = normalizeMiniHoopsConfig(lobby?.settings);
  return {
    gameId: MINI_HOOPS_GAME_ID,
    roomCode: clean(lobby?.roomCode, 8),
    authorityMode: "server",
    phase: "scheduled",
    startAt: Number(startAt) || Date.now(),
    endsAt: (Number(startAt) || Date.now()) + config.duration * 1000,
    config,
    players: [...(lobby?.members || [])].map((clientId, index) => playerFromLobby(lobby, clientId, index)),
    winnerIds: [],
    lastShot: null,
    sequence: 0,
    endedReason: "",
  };
}

export function applyMiniHoopsShot(match, clientId, rawIntent, now = Date.now(), adjudicate = adjudicateMiniHoopsShot) {
  if (!match || match.phase === "complete" || match.phase === "paused" || now < match.startAt || now >= match.endsAt) return match;
  const index = match.players.findIndex((player) => player.id === clientId && player.connected !== false);
  if (index < 0) return match;
  const intent = sanitizeMiniHoopsShot(rawIntent);
  if (intent.expectedShotNumber !== match.players[index].shots) return match;

  const ruling = adjudicate({
    intent,
    config: match.config,
    motionSeconds: Math.max(0, (now - match.startAt) / 1000),
  }) || {};
  const next = structuredClone(match);
  next.phase = "live";
  const player = next.players[index];
  player.shots += 1;
  if (ruling.scored === true) {
    player.score += 2;
    player.made += 1;
    player.streak += 1;
    player.bestStreak = Math.max(player.bestStreak, player.streak);
  } else {
    player.streak = 0;
  }
  next.sequence += 1;
  next.lastShot = {
    sequence: next.sequence,
    shooterId: clientId,
    serverAt: now,
    motionSeconds: Math.max(0, (now - next.startAt) / 1000),
    intent,
    scored: ruling.scored === true,
    contacts: Array.isArray(ruling.contacts) ? ruling.contacts.slice(0, 16).map(String) : [],
  };
  return next;
}

export function finalizeMiniHoopsMatch(match, now = Date.now(), reason = "time") {
  if (!match || match.phase === "complete" || (reason === "time" && now < match.endsAt)) return match;
  const next = structuredClone(match);
  const eligible = next.players;
  const best = eligible.length ? Math.max(...eligible.map(({ score }) => score)) : 0;
  next.phase = "complete";
  next.endedReason = reason;
  next.winnerIds = eligible.filter(({ score }) => score === best).map(({ id }) => id);
  return next;
}

export function applyMiniHoopsDisconnect(match, clientId, now = Date.now()) {
  if (!match || match.phase === "complete") return match;
  const next = structuredClone(match);
  const player = next.players.find(({ id }) => id === clientId);
  if (!player) return match;
  if (player.connected === false) {
    const remaining = next.players.filter(({ id, connected }) => id !== clientId && connected !== false);
    next.phase = "complete";
    next.endedReason = "forfeit";
    next.winnerIds = remaining.map(({ id }) => id);
    return next;
  }
  player.connected = false;
  next.phase = "paused";
  return next;
}

export function applyMiniHoopsReconnect(match, clientId) {
  if (!match || match.phase === "complete") return match;
  const next = structuredClone(match);
  const player = next.players.find(({ id }) => id === clientId);
  if (!player) return match;
  player.connected = true;
  next.phase = nowPhase(next, Date.now());
  return next;
}

function nowPhase(match, now) {
  return now < match.startAt ? "scheduled" : "live";
}

export function serializeMiniHoopsMatch(match, serverNow = Date.now()) {
  return {
    authorityMode: "server",
    gameId: MINI_HOOPS_GAME_ID,
    roomCode: match.roomCode,
    serverNow,
    startAt: match.startAt,
    endsAt: match.endsAt,
    phase: match.phase,
    config: { ...match.config },
    players: match.players.map((player) => ({ ...player })),
    sequence: match.sequence,
    lastShot: match.lastShot ? structuredClone(match.lastShot) : null,
    result: match.phase === "complete" ? { winnerIds: [...match.winnerIds], reason: match.endedReason } : null,
  };
}
