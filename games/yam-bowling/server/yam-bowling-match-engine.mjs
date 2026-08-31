import {
  YAM_BALL_PROFILES,
  clearFallen,
  createRack,
  simulateShot,
} from "../shared/yam-bowling-physics.mjs";
import { simulate3dShot, clear3dFallen } from "../shared/yam-bowling-3d.mjs";

export const YAM_BOWLING_GAME_ID = "yam-bowling";
export const YAM_BOWLING_PROTOCOL_VERSION = 3;
export const YAM_BOWLING_RECONNECT_GRACE_MS = 30_000;
export const YAM_BOWLING_REACTION_COOLDOWN_MS = 2_000;
// The two reaction wheels a bowler throws mid-match -- stickers and spoken
// lines -- with their founding fallbacks in wheel order. The server does not own
// the emote or catch-line catalogs any more than it owns the skin or lane
// catalogs: it checks the slug shape and holds the wheels a client declared at
// match start. What it does own is the mapping from a slot index to an id, which
// is the whole reason the wire carries an index -- a client can pick between its
// own four, and cannot name a fifth it never equipped.
//
// The cooldown is deliberately shared across both kinds. It is there to stop the
// channel being spammed at an opponent, and a spammer does not care whether the
// noise is a picture or a sentence.
export const YAM_BOWLING_REACTION_WHEEL_DEFAULTS = Object.freeze({
  emote: Object.freeze(["emote:wave", "emote:thumbs-up", "emote:good-luck", "emote:nice-one"]),
  "catch-line": Object.freeze([
    "catch-line:ready-to-roll",
    "catch-line:good-game",
    "catch-line:keep-it-clean",
    "catch-line:find-the-pocket",
  ]),
});

export const YAM_BOWLING_REACTION_WHEEL_FIELDS = Object.freeze({
  emote: "emoteIds",
  "catch-line": "catchLineIds",
});

const MODE_FRAMES = Object.freeze({ quick: 3, classic: 10 });
const DEFAULT_CHARACTERS = ["daisy-monroe", "nia-brooks"];
const DEFAULT_SKIN_ID = "canon";

// The two wheels are arrays, so a shallow presentation spread would leave every
// clone of a match sharing one list. Nothing mutates a frozen wheel today; a
// shared mutable array between match revisions is the kind of thing that only
// stops being harmless once something does.
function clonePresentation(presentation = {}) {
  const wheels = Object.fromEntries(Object.values(YAM_BOWLING_REACTION_WHEEL_FIELDS)
    .map((field) => [field, [...(presentation?.[field] || [])]]));
  return { ...presentation, ...wheels };
}

function clonePins(pins = []) {
  return pins.map((pin) => ({ ...pin }));
}

function clonePlayers(players = []) {
  return players.map((player) => ({
    ...player,
    presentation: clonePresentation(player.presentation),
    frames: player.frames.map((frame) => [...frame]),
    score: { ...player.score, cumulative: [...player.score.cumulative] },
  }));
}

function cloneMatch(match) {
  return {
    ...match,
    players: clonePlayers(match.players),
    winnerIds: [...match.winnerIds],
    pins: clonePins(match.pins),
    rematchRequestedBy: [...match.rematchRequestedBy],
    reactionCooldowns: { ...(match.reactionCooldowns || {}) },
    lastRoll: match.lastRoll
      ? { ...match.lastRoll, shot: { ...match.lastRoll.shot }, pinsBefore: clonePins(match.lastRoll.pinsBefore), pinsAfter: clonePins(match.lastRoll.pinsAfter),
        ...(match.lastRoll.pinFalls ? { pinFalls: match.lastRoll.pinFalls.map(pin => ({ ...pin })) } : {}) }
      : null,
    result: match.result ? { ...match.result } : null,
  };
}

function normalizeModeId(value) {
  return value === "classic" ? "classic" : "quick";
}

function cleanText(value, fallback, maxLength) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, maxLength).trim() || fallback;
}

// Every declared wheel, padded to length and shape-checked against its kind's
// own prefix. `item` is passed in rather than duplicated so the lobby's profile
// sanitizer and this one cannot drift on what a valid id looks like.
export function reactionWheels(raw, item) {
  return Object.fromEntries(Object.entries(YAM_BOWLING_REACTION_WHEEL_FIELDS).map(([kind, field]) => [
    field,
    YAM_BOWLING_REACTION_WHEEL_DEFAULTS[kind].map((fallback, index) => item(
      Array.isArray(raw?.[field]) ? raw[field][index] : "",
      kind,
      fallback,
    )),
  ]));
}

function presentationFromProfile(profile, characterSlug) {
  const raw = profile?.presentation || {};
  const item = (value, prefix, fallback) => {
    const text = cleanText(value, "", 96).toLowerCase();
    return new RegExp(`^${prefix}:[a-z0-9-]{1,64}$`).test(text) ? text : fallback;
  };
  const victoryPoseId = cleanText(raw.victoryPoseId, "", 96).toLowerCase();
  return {
    ballTrailId: item(raw.ballTrailId, "ball-trail", "ball-trail:none"),
    strikeBurstId: item(raw.strikeBurstId, "strike-burst", "strike-burst:classic"),
    victoryPoseId: victoryPoseId.startsWith(`victory-pose:${characterSlug}:`)
      && /^victory-pose:[a-z0-9-]+:[a-z0-9-]+$/.test(victoryPoseId)
      ? victoryPoseId
      : `victory-pose:${characterSlug}:canon`,
    // Both wheels are frozen here, at match start, and never re-read from a
    // later profile message -- so re-equipping mid-match cannot change what a
    // slot index resolves to partway through a frame.
    ...reactionWheels(raw, item),
    playerCardId: item(raw.playerCardId, "player-card", `player-card:${characterSlug}`),
    profileIconId: item(raw.profileIconId, "profile-icon", ""),
    entranceId: item(raw.entranceId, "entrance", ""),
  };
}

function isFinalFrameComplete(rolls) {
  if (rolls.length < 2) return false;
  return rolls[0] === 10 || rolls[0] + rolls[1] === 10 ? rolls.length >= 3 : true;
}

function isFrameComplete(rolls, isFinal) {
  return isFinal ? isFinalFrameComplete(rolls) : rolls[0] === 10 || rolls.length >= 2;
}

function pinsStandingForRolls(rolls, isFinal) {
  if (!rolls.length) return 10;
  if (!isFinal) return rolls[0] === 10 ? 0 : 10 - rolls[0];
  if (rolls.length === 1) return rolls[0] === 10 ? 10 : 10 - rolls[0];
  if (rolls.length === 2) {
    if (rolls[0] === 10) return rolls[1] === 10 ? 10 : 10 - rolls[1];
    if (rolls[0] + rolls[1] === 10) return 10;
  }
  return 0;
}

function futureRolls(frames, frameIndex) {
  const rolls = [];
  for (let index = frameIndex + 1; index < frames.length; index += 1) rolls.push(...frames[index]);
  return rolls;
}

function scoreFrames(frames) {
  const cumulative = Array(frames.length).fill(null);
  let total = 0;
  for (let index = 0; index < frames.length; index += 1) {
    const rolls = frames[index];
    const isFinal = index === frames.length - 1;
    if (!isFrameComplete(rolls, isFinal)) break;
    if (isFinal) {
      total += rolls.slice(0, 3).reduce((sum, pins) => sum + pins, 0);
      cumulative[index] = total;
      break;
    }
    if (rolls[0] === 10) {
      const bonus = futureRolls(frames, index).slice(0, 2);
      if (bonus.length < 2) break;
      total += 10 + bonus[0] + bonus[1];
    } else if (rolls[0] + rolls[1] === 10) {
      const bonus = futureRolls(frames, index)[0];
      if (bonus == null) break;
      total += 10 + bonus;
    } else {
      total += rolls[0] + rolls[1];
    }
    cumulative[index] = total;
  }
  return { total, cumulative };
}

function expectedStanding(match) {
  const frames = MODE_FRAMES[match.modeId];
  const rolls = match.players[match.activePlayer].frames[match.frameIndex];
  return pinsStandingForRolls(rolls, match.frameIndex === frames - 1);
}

function recordRoll(match, knocked) {
  const player = match.players[match.activePlayer];
  const rolls = player.frames[match.frameIndex];
  rolls.push(knocked);
  player.score = scoreFrames(player.frames);
  const finalFrame = match.frameIndex === MODE_FRAMES[match.modeId] - 1;
  if (!isFrameComplete(rolls, finalFrame)) return;
  if (match.activePlayer < match.players.length - 1) {
    match.activePlayer += 1;
  } else if (!finalFrame) {
    match.activePlayer = 0;
    match.frameIndex += 1;
  } else {
    match.phase = "complete";
    match.status = "complete";
    match.players.forEach((entry) => { entry.score = scoreFrames(entry.frames); });
    const high = Math.max(...match.players.map((entry) => entry.score.total));
    match.winnerIds = match.players.filter((entry) => entry.score.total === high).map((entry) => entry.id);
    match.result = {
      reason: "score",
      winnerClientId: match.winnerIds.length === 1 ? match.winnerIds[0] : null,
      draw: match.winnerIds.length > 1,
    };
  }
}

function playerFromLobby(lobby, clientId, index) {
  const lobbyProfile = lobby?.memberProfiles?.get(clientId) || {};
  const yamProfile = lobby?.yamProfiles?.get(clientId) || {};
  const characterSlug = cleanText(yamProfile.characterSlug, DEFAULT_CHARACTERS[index] || DEFAULT_CHARACTERS[0], 64);
  return {
    id: clientId,
    accountPlayerId: cleanText(yamProfile.playerId || lobbyProfile.playerId, "", 64),
    name: cleanText(yamProfile.displayName || lobbyProfile.displayName, `Player ${index + 1}`, 24),
    characterSlug,
    skinId: cleanText(yamProfile.skinId, DEFAULT_SKIN_ID, 40),
    presentation: presentationFromProfile(yamProfile, characterSlug),
    type: "human",
    connected: true,
  };
}

// The house both bowlers see. The server picks it so the two clients cannot
// disagree, but it never learns what a lane *is*: it publishes an opaque roll
// and the client maps that onto its own lane catalog, the same split that keeps
// the skin catalog off this server. Deriving the roll from the match identity
// instead of Math.random keeps it stable across reconnects and re-serializes,
// while a rematch bumps matchNumber and therefore moves the pair to a new lane.
function rollLane(roomCode, seed, matchNumber) {
  let hash = 0x811c9dc5;
  for (const character of `${roomCode}:${seed}:${matchNumber}`) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 1_000_003;
}

function freshMatch({ players, modeId, bowlingStyle = "arcade", ranked = false, roomCode, seed, matchNumber, now }) {
  const frames = MODE_FRAMES[modeId];
  return {
    gameId: YAM_BOWLING_GAME_ID,
    modeId,
    bowlingStyle,
    // Frozen at creation, exactly like the mode and the lane roll. A client asks
    // the platform to move ELO only for a match the server called ranked, so the
    // stakes cannot be renegotiated once the first ball is thrown.
    ranked: ranked === true,
    playType: "online",
    cpuLevelId: "casual",
    roomCode,
    seed,
    matchNumber,
    laneRoll: rollLane(roomCode, seed, matchNumber),
    sessionId: `${YAM_BOWLING_GAME_ID}:${roomCode}:${seed}:${matchNumber}`,
    phase: "playing",
    status: "playing",
    frameIndex: 0,
    activePlayer: 0,
    winnerIds: [],
    players: players.map((player) => ({
      ...player,
      connected: true,
      frames: Array.from({ length: frames }, () => []),
      score: { total: 0, cumulative: Array(frames).fill(null) },
    })),
    pins: createRack(),
    rollNumber: 0,
    lastRoll: null,
    result: null,
    rematchRequestedBy: [],
    reactionSequence: 0,
    reactionCooldowns: {},
    disconnectedAt: null,
    pausedPhase: null,
    startedAt: now,
    lastActionAt: now,
  };
}

export function createYamMatchState(lobby, startAt = Date.now()) {
  const memberIds = [...(lobby?.members || [])].slice(0, 2);
  if (memberIds.length !== 2) throw new Error("Yam Bowling requires exactly two players.");
  const modeId = normalizeModeId(lobby?.settings?.matchType);
  return freshMatch({
    players: memberIds.map((clientId, index) => playerFromLobby(lobby, clientId, index)),
    modeId,
    ranked: lobby?.settings?.ranked === true,
    bowlingStyle: lobby?.settings?.bowlingStyle === "3d" ? "3d" : "arcade",
    roomCode: cleanText(lobby?.roomCode, "ROOM", 16),
    seed: Number.isFinite(Number(lobby?.seed)) ? Math.floor(Number(lobby.seed)) : 0,
    matchNumber: 1,
    now: startAt,
  });
}

function validateShot(raw, rollNumber) {
  if (!raw || typeof raw !== "object") return null;
  const ranges = {
    position: [-0.46, 0.46],
    aim: [-0.45, 0.45],
    hook: [-1, 1],
    power: [0.08, 1],
    release: [-0.035, 0.035],
  };
  const shot = {};
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = Number(raw[key]);
    if (!Number.isFinite(value) || value < min || value > max) return null;
    shot[key] = value;
  }
  const ballIndex = Number(raw.ballIndex);
  if (!Number.isInteger(ballIndex) || !YAM_BALL_PROFILES[ballIndex]) return null;
  if (!Number.isInteger(Number(raw.expectedRollNumber)) || Number(raw.expectedRollNumber) !== rollNumber) return { stale: true };
  shot.ballIndex = ballIndex;
  return shot;
}

function error(code, message) {
  return { code, message };
}

export function validateYamShotRequest(match, clientId, rawShot) {
  if (!match || match.phase !== "playing") {
    return { match, error: error("MATCH_NOT_PLAYING", "The match is not accepting shots.") };
  }
  const active = match.players[match.activePlayer];
  if (active?.id !== clientId) {
    return { match, error: error("NOT_YOUR_TURN", "Wait for the other bowler.") };
  }
  const shot = validateShot(rawShot, match.rollNumber);
  if (shot?.stale) return { match, error: error("NOT_READY_FOR_SHOT", "That roll was already processed.") };
  if (!shot) return { match, error: error("INVALID_SHOT", "Shot inputs were outside the legal lane controls.") };
  return { shot, error: null };
}

export function applyYamShot(match, clientId, rawShot, now = Date.now(), resolvedShot = null) {
  const validated = validateYamShotRequest(match, clientId, rawShot);
  if (validated.error) return validated;
  const { shot } = validated;

  const next = cloneMatch(match);
  const pinsBefore = clonePins(next.pins);
  const resolved = resolvedShot || (next.bowlingStyle === "3d" ? simulate3dShot(pinsBefore, shot) : simulateShot(pinsBefore, shot));
  const standing = expectedStanding(next);
  const knocked = Math.max(0, Math.min(standing, Math.round(resolved.knocked)));
  recordRoll(next, knocked);
  next.rollNumber += 1;
  next.lastActionAt = now;
  next.lastRoll = {
    rollNumber: next.rollNumber,
    shooterClientId: clientId,
    shot,
    knocked,
    startedStanding: standing,
    pinsBefore,
    pinsAfter: clonePins(resolved.pins),
    ...(next.bowlingStyle === "3d" ? { pinFalls: resolved.pinFalls, duration: resolved.duration } : {}),
    resolvedAt: now,
  };
  next.pins = next.phase === "complete"
    ? clonePins(resolved.pins)
    : expectedStanding(next) === 10
      ? createRack()
      : next.bowlingStyle === "3d" ? clear3dFallen(resolved.pins) : clearFallen(resolved.pins);
  return { match: next, error: null };
}

// Resolves a client-sent kind and wheel slot against the wheels frozen into the
// match at start. An unknown kind is refused, because there is no wheel to fall
// back to; an out-of-range slot within a known kind falls back to that wheel's
// first entry rather than erroring, since the wheel is cosmetic and refusing
// would spend the sender's cooldown on nothing.
function reactionFromSlot(player, kind, slot) {
  const field = YAM_BOWLING_REACTION_WHEEL_FIELDS[kind];
  if (!field) return "";
  const wheel = Array.isArray(player?.presentation?.[field]) ? player.presentation[field] : [];
  const defaults = YAM_BOWLING_REACTION_WHEEL_DEFAULTS[kind];
  const index = Number(slot);
  const chosen = Number.isInteger(index) && index >= 0 && index < defaults.length ? wheel[index] : null;
  return chosen || wheel[0] || defaults[0];
}

export function applyYamReaction(match, clientId, kind = "emote", slot = 0, now = Date.now()) {
  if (!match || match.phase !== "playing") {
    return { match, event: null, error: error("MATCH_NOT_PLAYING", "Reactions are available during a live match.") };
  }
  const player = match.players.find((entry) => entry.id === clientId);
  if (!player) return { match, event: null, error: error("NOT_IN_MATCH", "That bowler is not in this match.") };
  const reactionId = reactionFromSlot(player, kind, slot);
  if (!reactionId) {
    return { match, event: null, error: error("UNKNOWN_REACTION", "That reaction kind is not part of this match.") };
  }
  const lastSentAt = Number(match.reactionCooldowns?.[clientId]) || 0;
  if (lastSentAt && now - lastSentAt < YAM_BOWLING_REACTION_COOLDOWN_MS) {
    return { match, event: null, error: error("REACTION_COOLDOWN", "Wait a moment before reacting again.") };
  }
  const next = cloneMatch(match);
  next.reactionSequence = (Number(next.reactionSequence) || 0) + 1;
  next.reactionCooldowns[clientId] = now;
  return {
    match: next,
    event: {
      senderClientId: clientId,
      // The whole resolved id, not the slot: the receiving client reads the kind
      // off its prefix, so a kind and an id can never arrive disagreeing.
      reactionId,
      sequence: next.reactionSequence,
    },
    error: null,
  };
}

export function applyYamDisconnect(match, clientId, now = Date.now()) {
  if (!match || match.phase === "complete") return match;
  const index = match.players.findIndex((player) => player.id === clientId);
  if (index < 0) return match;
  const next = cloneMatch(match);
  if (next.players[index].connected === false) {
    const winner = next.players.find((player) => player.id !== clientId);
    next.phase = "complete";
    next.status = "complete";
    next.winnerIds = winner ? [winner.id] : [];
    next.result = { reason: "disconnect", winnerClientId: winner?.id || null, loserClientId: clientId, draw: false };
    next.lastActionAt = now;
    return next;
  }
  next.players[index].connected = false;
  next.pausedPhase = next.phase;
  next.phase = "paused";
  next.disconnectedAt = now;
  next.lastActionAt = now;
  return next;
}

export function applyYamReconnect(match, clientId, now = Date.now()) {
  if (!match || match.phase === "complete") return match;
  const index = match.players.findIndex((player) => player.id === clientId);
  if (index < 0 || match.players[index].connected !== false) return match;
  const next = cloneMatch(match);
  next.players[index].connected = true;
  next.phase = next.pausedPhase || "playing";
  next.pausedPhase = null;
  next.disconnectedAt = null;
  next.lastActionAt = now;
  return next;
}

export function requestYamRematch(match, clientId, now = Date.now()) {
  if (!match || match.phase !== "complete" || !match.players.some((player) => player.id === clientId)) {
    return { match, started: false };
  }
  const next = cloneMatch(match);
  if (!next.rematchRequestedBy.includes(clientId)) next.rematchRequestedBy.push(clientId);
  if (!next.players.every((player) => next.rematchRequestedBy.includes(player.id))) return { match: next, started: false };
  return {
    match: freshMatch({
      players: next.players.map(({ id, accountPlayerId, name, characterSlug, skinId, presentation, type }) => ({
        id, accountPlayerId, name, characterSlug, skinId, presentation: { ...presentation }, type,
      })),
      modeId: next.modeId,
      bowlingStyle: next.bowlingStyle,
      // A rematch keeps the stakes it was agreed under: the lobby settings are
      // locked once a match starts, so there is nowhere for them to have changed.
      ranked: next.ranked === true,
      roomCode: next.roomCode,
      seed: next.seed,
      matchNumber: next.matchNumber + 1,
      now,
    }),
    started: true,
  };
}

export function serializeYamMatch(match, lobby, serverNow = Date.now()) {
  const serial = cloneMatch(match);
  const matchView = {
    modeId: serial.modeId,
    bowlingStyle: serial.bowlingStyle || "arcade",
    playType: "online",
    cpuLevelId: "casual",
    frameIndex: serial.frameIndex,
    activePlayer: serial.activePlayer,
    status: serial.status,
    winnerIds: serial.winnerIds,
    players: serial.players,
  };
  return {
    authorityMode: "server",
    gameId: YAM_BOWLING_GAME_ID,
    roomCode: serial.roomCode,
    sessionId: serial.sessionId,
    modeId: serial.modeId,
    ranked: serial.ranked === true,
    bowlingStyle: serial.bowlingStyle || "arcade",
    laneRoll: serial.laneRoll,
    phase: serial.phase,
    rollNumber: serial.rollNumber,
    activeClientId: serial.phase === "complete" ? null : serial.players[serial.activePlayer]?.id || null,
    match: matchView,
    lastRoll: serial.lastRoll,
    nextPins: serial.pins,
    result: serial.result,
    rematchRequestedBy: serial.rematchRequestedBy,
    serverNow,
    reconnectGraceMs: YAM_BOWLING_RECONNECT_GRACE_MS,
    lobbyStatus: lobby?.status || null,
  };
}
