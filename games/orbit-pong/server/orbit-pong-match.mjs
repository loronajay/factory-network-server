import { createState, startState, stepState } from "../shared/simulation.mjs";

function publicPlayer(record) {
  return {
    playerId: record.playerId,
    id: record.playerId,
    displayName: record.displayName,
    ready: record.ready,
  };
}

export function createOrbitPongMatch({ seed = 1 } = {}) {
  const seats = [];
  let state = null;

  function addPlayer(clientId, identity = {}) {
    if (seats.length >= 2 || seats.some((seat) => seat.clientId === clientId)) return { ok: false, code: "ROOM_FULL" };
    const seat = {
      clientId,
      playerId: String(identity.playerId || `guest-${seats.length + 1}`),
      displayName: String(identity.displayName || `Player ${seats.length + 1}`).slice(0, 18),
      ready: false,
      command: { orbit: 0 },
      acknowledgedSequence: 0,
    };
    seats.push(seat);
    return { ok: true, playerIndex: seats.length - 1, player: publicPlayer(seat) };
  }

  function removePlayer(clientId) {
    const index = seats.findIndex((seat) => seat.clientId === clientId);
    if (index < 0) return null;
    const [removed] = seats.splice(index, 1);
    if (state && state.phase !== "MATCH_OVER" && seats.length === 1) {
      state.phase = "MATCH_OVER";
      state.winnerId = seats[0].playerId;
    }
    return { removed: publicPlayer(removed), winnerId: state?.winnerId ?? null };
  }

  function setReady(clientId, ready) {
    const seat = seats.find((entry) => entry.clientId === clientId);
    if (!seat || state) return false;
    seat.ready = !!ready;
    return true;
  }

  function start() {
    if (seats.length !== 2 || !seats.every((seat) => seat.ready)) return { ok: false, code: "NOT_READY" };
    state = createState(seed, seats);
    startState(state);
    return { ok: true };
  }

  function setInput(clientId, input = {}) {
    const seat = seats.find((entry) => entry.clientId === clientId);
    if (!seat || !state || state.phase === "MATCH_OVER") return { ok: false, code: "NOT_PLAYING" };
    const sequence = Math.max(0, Math.floor(Number(input.sequence) || 0));
    if (sequence <= seat.acknowledgedSequence) return { ok: false, code: "STALE_INPUT" };
    seat.acknowledgedSequence = sequence;
    seat.command = { orbit: Math.sign(Math.max(-1, Math.min(1, Number(input.orbit) || 0))) };
    return { ok: true };
  }

  function tick() {
    if (!state || state.phase === "MATCH_OVER") return [];
    return stepState(state, seats.map((seat) => seat.command));
  }

  function snapshot() {
    if (!state) return null;
    return {
      tick: state.tick,
      phase: state.phase,
      ball: {
        x: state.ball.x,
        y: state.ball.y,
        vx: state.ball.vx,
        vy: state.ball.vy,
        lastTouchPlayerId: state.ball.lastTouchPlayerId,
      },
      paddles: state.paddles.map((paddle) => ({
        id: paddle.id,
        angle: paddle.angle,
        angularVelocity: paddle.angularVelocity,
      })),
      scores: state.players.map((player) => player.score),
      acknowledgedSequences: seats.map((seat) => seat.acknowledgedSequence),
      winnerId: state.winnerId,
      servePlan: state.servePlan,
    };
  }

  return {
    addPlayer,
    removePlayer,
    setReady,
    start,
    setInput,
    tick,
    snapshot,
    playerIndex: (clientId) => seats.findIndex((seat) => seat.clientId === clientId),
    players: () => seats.map(publicPlayer),
    everyoneReady: () => seats.length === 2 && seats.every((seat) => seat.ready),
    get started() { return state !== null; },
    get complete() { return state?.phase === "MATCH_OVER"; },
  };
}
