import { createAuthoritativeMatchState, applyPlayerIntent } from "../shared/match-engine.mjs";
import {
  createDisconnectWinResult,
  createScoreWinResult,
  createTimerDrawResult,
  createTimerWinResult
} from "../shared/match-results.mjs";

const DEFAULT_MATCH_DURATION_MS = 5 * 60 * 1000;

function clonePlayer(player) {
  return player ? { ...player } : null;
}

function snapshotPlayers(playersBySide) {
  return {
    blue: clonePlayer(playersBySide.blue),
    red: clonePlayer(playersBySide.red)
  };
}

function otherSide(side) {
  return side === "blue" ? "red" : "blue";
}

export function createCircuitSiegeRoomEngine({
  board,
  boardId = null,
  roomId = "circuit-siege-room",
  roomCode = "CS01",
  roomType = "public",
  matchDurationMs = DEFAULT_MATCH_DURATION_MS,
  initialScores = null
} = {}) {
  const room = {
    roomId,
    roomCode,
    roomType,
    phase: "lobby",
    playersBySide: {
      blue: null,
      red: null
    },
    startedAt: null,
    endsAt: null,
    lastUpdatedAt: null,
    result: null,
    matchState: null
  };

  function getSnapshot() {
    const timerMsRemaining = room.phase === "live" && Number.isFinite(room.endsAt)
      ? Math.max(0, Math.floor(room.endsAt - Number(room.lastUpdatedAt ?? room.startedAt ?? room.endsAt)))
      : 0;

    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      roomType: room.roomType,
      boardId: boardId || board?.mapId || null,
      phase: room.phase,
      startedAt: room.startedAt,
      endsAt: room.endsAt,
      timerMsRemaining,
      result: room.result ? { ...room.result } : null,
      players: snapshotPlayers(room.playersBySide),
      scores: room.matchState ? { ...room.matchState.scores } : { blue: 0, red: 0 },
      routes: room.matchState ? room.matchState.routes : {},
      terminals: room.matchState ? room.matchState.terminals : {},
      slots: room.matchState ? room.matchState.slots : {}
    };
  }

  function assignPlayer({ clientId, playerId, displayName, side }) {
    if (side !== "blue" && side !== "red") {
      return { ok: false, errorCode: "INVALID_SIDE" };
    }

    if (room.playersBySide[side]) {
      return { ok: false, errorCode: "SIDE_TAKEN" };
    }

    const player = {
      clientId,
      playerId,
      displayName,
      side,
      ready: true,
      connected: true
    };

    room.playersBySide[side] = player;
    return { ok: true, player: clonePlayer(player), snapshot: getSnapshot() };
  }

  function setPlayerReady(clientId, ready) {
    const player = room.playersBySide.blue?.clientId === clientId
      ? room.playersBySide.blue
      : room.playersBySide.red?.clientId === clientId
        ? room.playersBySide.red
        : null;

    if (!player) {
      return { ok: false, errorCode: "PLAYER_NOT_FOUND" };
    }

    player.ready = !!ready;
    return { ok: true, player: clonePlayer(player), snapshot: getSnapshot() };
  }

  function startMatch({ now = Date.now() } = {}) {
    const blue = room.playersBySide.blue;
    const red = room.playersBySide.red;

    if (!blue || !red) {
      return { ok: false, errorCode: "PLAYERS_MISSING" };
    }

    room.phase = "live";
    room.startedAt = now;
    room.endsAt = now + matchDurationMs;
    room.lastUpdatedAt = now;
    room.result = null;
    room.matchState = createAuthoritativeMatchState(board, {
      matchId: room.roomId,
      initialScores
    });

    return { ok: true, snapshot: getSnapshot() };
  }

  function maybeFinishForScore() {
    if (!room.matchState) return null;

    if (room.matchState.scores.blue >= 5) {
      room.phase = "ended";
      room.result = createScoreWinResult("blue", "red");
      room.matchState.phase = "ended";
      return room.result;
    }

    if (room.matchState.scores.red >= 5) {
      room.phase = "ended";
      room.result = createScoreWinResult("red", "blue");
      room.matchState.phase = "ended";
      return room.result;
    }

    return null;
  }

  function applyIntentForClient({ clientId, intent, receivedAt = Date.now() }) {
    if (room.phase !== "live" || !room.matchState) {
      return { ok: false, errorCode: "MATCH_NOT_LIVE", snapshot: getSnapshot() };
    }

    const player = room.playersBySide.blue?.clientId === clientId
      ? room.playersBySide.blue
      : room.playersBySide.red?.clientId === clientId
        ? room.playersBySide.red
        : null;

    if (!player) {
      return { ok: false, errorCode: "PLAYER_NOT_FOUND", snapshot: getSnapshot() };
    }

    const applied = applyPlayerIntent(room.matchState, {
      ...intent,
      playerSide: player.side,
      receivedAt
    });

    if (!applied.ok) {
      return { ...applied, snapshot: getSnapshot() };
    }

    room.matchState = applied.state;
    room.lastUpdatedAt = receivedAt;
    maybeFinishForScore();

    return {
      ok: true,
      resolvedRoute: applied.resolvedRoute,
      snapshot: getSnapshot()
    };
  }

  function tick(now = Date.now()) {
    if (room.phase !== "live" || room.result || room.endsAt === null) {
      return { ok: false, errorCode: "NO_ACTIVE_TIMER", snapshot: getSnapshot() };
    }

    if (now < room.endsAt) {
      return { ok: false, errorCode: "TIMER_NOT_EXPIRED", snapshot: getSnapshot() };
    }

    room.phase = "ended";
    room.lastUpdatedAt = now;
    const blueScore = Number(room.matchState?.scores?.blue || 0);
    const redScore = Number(room.matchState?.scores?.red || 0);
    room.result = blueScore === redScore
      ? createTimerDrawResult()
      : blueScore > redScore
        ? createTimerWinResult("blue", "red")
        : createTimerWinResult("red", "blue");
    if (room.matchState) {
      room.matchState.phase = "ended";
    }

    return { ok: true, snapshot: getSnapshot() };
  }

  function handleDisconnect(clientId) {
    const player = room.playersBySide.blue?.clientId === clientId
      ? room.playersBySide.blue
      : room.playersBySide.red?.clientId === clientId
        ? room.playersBySide.red
        : null;

    if (!player) {
      return { ok: false, errorCode: "PLAYER_NOT_FOUND", snapshot: getSnapshot() };
    }

    player.connected = false;

    if (room.phase === "live") {
      const winnerSide = otherSide(player.side);
      room.phase = "ended";
      room.lastUpdatedAt = room.lastUpdatedAt ?? room.startedAt ?? 0;
      room.result = createDisconnectWinResult(winnerSide, player.side, "opponent disconnected");
      if (room.matchState) {
        room.matchState.phase = "ended";
      }
      return { ok: true, snapshot: getSnapshot() };
    }

    room.playersBySide[player.side] = null;
    return { ok: true, snapshot: getSnapshot() };
  }

  return {
    assignPlayer,
    setPlayerReady,
    startMatch,
    applyIntent: applyIntentForClient,
    tick,
    handleDisconnect,
    getSnapshot
  };
}
