// Build Buddy authoritative match engine — pure state transitions + pure
// serializers. Server owns stage results and role swaps; clients may not publish
// authoritative state. The lobby adapter handles broadcasting and wiring.
import { sanitizeDisplayName } from "../../../src/util.mjs";

export const BUILD_BUDDY_GAME_ID = "build-buddy";
export const BUILD_BUDDY_PHASES = {
  STAGE_PLAY: "stage_play",
  RUN_COMPLETE: "run_complete",
  MATCH_OVER: "match_over",
};
const BUILD_BUDDY_TOOLS = new Set(["platform", "springYellow", "springGreen", "springBlue", "checkpoint"]);

function buildBuildBuddyStageSequence(packId = "pack_01") {
  const safePackId = typeof packId === "string" && packId.trim() ? packId.trim() : "pack_01";
  return Array.from({ length: 10 }, (_, index) => `${safePackId}_stage_${String(index + 1).padStart(2, "0")}`);
}

function createBuildBuddyPlayersFromLobby(lobby) {
  const memberIds = lobby?.members ? [...lobby.members].slice(0, 2) : [];
  return memberIds.map((clientId, index) => {
    const profile = lobby?.memberProfiles instanceof Map ? lobby.memberProfiles.get(clientId) : null;
    return {
      id: clientId,
      clientId,
      name: sanitizeDisplayName(profile?.displayName, `Player ${index + 1}`),
      connected: true,
    };
  });
}

function buildBuildBuddyRoles(players, stageIndex) {
  const first = players[0]?.id || "";
  const second = players[1]?.id || "";
  const runnerFirst = Number(stageIndex || 0) % 2 === 0;
  return {
    runnerPlayerId: runnerFirst ? first : second,
    builderPlayerId: runnerFirst ? second : first,
  };
}

function cloneBuildBuddyMatch(match) {
  return {
    ...match,
    players: match.players.map((player) => ({ ...player })),
    stageSequence: [...match.stageSequence],
    roles: { ...match.roles },
    stageResults: match.stageResults.map((result) => ({ ...result })),
    runnerInputs: match.runnerInputs.map((input) => ({ ...input })),
    builderCommands: match.builderCommands.map((command) => ({ ...command })),
    rejections: match.rejections.map((rejection) => ({ ...rejection })),
  };
}

function parseLobbyMessageValue(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeBuildBuddyTick(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
}

function normalizeBuildBuddyBool(value) {
  return value === true || value === 1 || value === "true";
}

function normalizeBuildBuddyCoord(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
}

function rejectBuildBuddyInput(match, clientId, reason, messageType = "") {
  const next = cloneBuildBuddyMatch(match);
  next.rejections.push({
    clientId,
    reason,
    messageType,
    stageIndex: next.stageIndex,
  });
  next.status = `Rejected Build Buddy ${messageType || "message"}: ${reason}`;
  return next;
}

export function createBuildBuddyMatchState(lobby, now = Date.now()) {
  const players = createBuildBuddyPlayersFromLobby(lobby);
  const packId = typeof lobby?.settings?.packId === "string" && lobby.settings.packId ? lobby.settings.packId : "pack_01";
  const stageSequence = buildBuildBuddyStageSequence(packId);
  const stageIndex = 0;
  return {
    roomCode: lobby.roomCode,
    gameId: BUILD_BUDDY_GAME_ID,
    mode: "online",
    authorityMode: "server",
    phase: BUILD_BUDDY_PHASES.STAGE_PLAY,
    packId,
    runFormat: lobby?.settings?.runFormat || "canon_10_stage",
    seed: Number.isFinite(Number(lobby?.seed)) ? Math.abs(Number(lobby.seed)) : 0,
    stageIndex,
    currentStageId: stageSequence[stageIndex],
    stageSequence,
    roles: buildBuildBuddyRoles(players, stageIndex),
    players,
    stageResults: [],
    runnerInputs: [],
    builderCommands: [],
    commandSeq: 0,
    rejections: [],
    winnerId: null,
    status: "Server-authoritative Build Buddy run started.",
    createdAt: now,
    updatedAt: now,
  };
}

export function applyBuildBuddyInputToMatch(match, clientId, message = {}, now = Date.now()) {
  if (!match || match.phase !== BUILD_BUDDY_PHASES.STAGE_PLAY) return match;
  const messageType = String(message.messageType || "");
  const parsed = parseLobbyMessageValue(message.value);
  if (!parsed) return rejectBuildBuddyInput(match, clientId, "bad_payload", messageType);

  const next = cloneBuildBuddyMatch(match);
  if (messageType === "runner_input") {
    if (clientId !== next.roles.runnerPlayerId) return rejectBuildBuddyInput(match, clientId, "wrong_runner_role", messageType);
    next.commandSeq = Number(next.commandSeq || 0) + 1;
    next.runnerInputs.push({
      seq: next.commandSeq,
      clientId,
      tick: normalizeBuildBuddyTick(parsed.tick),
      left: normalizeBuildBuddyBool(parsed.left),
      right: normalizeBuildBuddyBool(parsed.right),
      up: normalizeBuildBuddyBool(parsed.up),
      down: normalizeBuildBuddyBool(parsed.down),
      jump: normalizeBuildBuddyBool(parsed.jump),
      reposition: normalizeBuildBuddyBool(parsed.reposition),
      receivedAt: now,
      stageIndex: next.stageIndex,
    });
    next.updatedAt = now;
    next.status = "Runner input accepted by server.";
    return next;
  }

  if (messageType === "builder_command") {
    if (clientId !== next.roles.builderPlayerId) return rejectBuildBuddyInput(match, clientId, "wrong_builder_role", messageType);
    const action = parsed.action === "delete" ? "delete" : "place";
    const toolType = action === "place" && BUILD_BUDDY_TOOLS.has(parsed.toolType) ? parsed.toolType : null;
    if (action === "place" && !toolType) return rejectBuildBuddyInput(match, clientId, "unknown_tool", messageType);
    next.commandSeq = Number(next.commandSeq || 0) + 1;
    next.builderCommands.push({
      seq: next.commandSeq,
      clientId,
      tick: normalizeBuildBuddyTick(parsed.tick),
      commandId: typeof parsed.commandId === "string" && parsed.commandId ? parsed.commandId.slice(0, 80) : `${clientId}:${now}`,
      action,
      toolType,
      gridX: normalizeBuildBuddyCoord(parsed.gridX),
      gridY: normalizeBuildBuddyCoord(parsed.gridY),
      receivedAt: now,
      stageIndex: next.stageIndex,
    });
    next.updatedAt = now;
    next.status = "Builder command accepted by server.";
    return next;
  }

  return rejectBuildBuddyInput(match, clientId, "unsupported_message", messageType);
}

export function applyBuildBuddyStageEventToMatch(match, clientId, message = {}, now = Date.now()) {
  if (!match || match.phase !== BUILD_BUDDY_PHASES.STAGE_PLAY) return match;
  const messageType = String(message.messageType || "");
  const parsed = parseLobbyMessageValue(message.value);
  if (messageType !== "stage_complete_request") return rejectBuildBuddyInput(match, clientId, "unsupported_message", messageType);
  if (!parsed) return rejectBuildBuddyInput(match, clientId, "bad_payload", messageType);
  if (clientId !== match.roles.runnerPlayerId) return rejectBuildBuddyInput(match, clientId, "wrong_completion_role", messageType);
  if (parsed.stageId !== match.currentStageId || Number(parsed.stageIndex) !== Number(match.stageIndex)) {
    return rejectBuildBuddyInput(match, clientId, "stage_mismatch", messageType);
  }
  return applyBuildBuddyStageResultToMatch(match, {
    outcome: parsed.outcome,
    failReason: parsed.failReason || parsed.reason,
    elapsedMs: parsed.elapsedMs,
  }, now);
}

export function applyBuildBuddyStageResultToMatch(match, result = {}, now = Date.now()) {
  if (!match || match.phase !== BUILD_BUDDY_PHASES.STAGE_PLAY) return match;
  const next = cloneBuildBuddyMatch(match);
  const outcome = result.outcome === "clear" ? "clear" : "fail";
  const stageResult = {
    packId: next.packId,
    stageId: next.currentStageId,
    stageIndex: next.stageIndex,
    runnerPlayerId: next.roles.runnerPlayerId,
    builderPlayerId: next.roles.builderPlayerId,
    outcome,
    failReason: outcome === "fail" ? (result.failReason || result.reason || "failure") : null,
    elapsedMs: Number.isFinite(Number(result.elapsedMs)) ? Math.max(0, Number(result.elapsedMs)) : Math.max(0, now - Number(next.createdAt || now)),
    recordedAt: now,
  };
  next.stageResults.push(stageResult);
  if (next.stageIndex >= next.stageSequence.length - 1) {
    next.phase = BUILD_BUDDY_PHASES.RUN_COMPLETE;
    next.currentStageId = next.stageSequence[next.stageIndex];
    next.status = "Build Buddy run complete.";
  } else {
    next.stageIndex += 1;
    next.currentStageId = next.stageSequence[next.stageIndex];
    next.roles = buildBuildBuddyRoles(next.players, next.stageIndex);
    next.runnerInputs = [];
    next.builderCommands = [];
    next.status = `Build Buddy advanced to ${next.currentStageId}.`;
  }
  next.updatedAt = now;
  return next;
}

export function applyBuildBuddyDisconnectToMatch(match, clientId, now = Date.now()) {
  if (!match || match.phase === BUILD_BUDDY_PHASES.MATCH_OVER) return match;
  const next = cloneBuildBuddyMatch(match);
  next.players = next.players.map((player) => (
    player.clientId === clientId || player.id === clientId ? { ...player, connected: false } : player
  ));
  next.phase = BUILD_BUDDY_PHASES.MATCH_OVER;
  next.winnerId = null;
  next.status = "closed_disconnect";
  next.updatedAt = now;
  return next;
}

export function serializeBuildBuddyMatchState(match, lobby = {}, now = Date.now()) {
  const snapshot = cloneBuildBuddyMatch(match);
  snapshot.network = {
    roomCode: lobby?.roomCode || match.roomCode,
    authorityMode: "server",
    syncSeq: Number(lobby?.buildBuddySyncSeq || 0),
    serverNow: now,
  };
  snapshot.stage = {
    packId: snapshot.packId,
    stageId: snapshot.currentStageId,
    stageIndex: snapshot.stageIndex,
    roles: { ...snapshot.roles },
  };
  snapshot.commands = {
    runnerInputs: snapshot.runnerInputs.map((input) => ({ ...input })),
    builderCommands: snapshot.builderCommands.map((command) => ({ ...command })),
  };
  return snapshot;
}

export function serializeBuildBuddyStageStartMessage(match, lobby = {}, now = Date.now()) {
  return {
    protocolVersion: 1,
    runId: `${match.roomCode || lobby?.roomCode || "build_buddy"}:${match.createdAt || 0}`,
    packId: match.packId,
    stageId: match.currentStageId,
    stageIndex: match.stageIndex,
    roles: { ...match.roles },
    seed: Number.isFinite(Number(match.seed)) ? Math.max(0, Math.floor(Number(match.seed))) : 0,
    startAt: now,
    authorityPlayerId: "server",
  };
}
