// Server-owned Orbit Pong simulation. Clients send orbit commands only; every
// collision, touch, point and serve is resolved here.
export const CONFIG = Object.freeze({
  tickRate: 60,
  arenaRadius: 268,
  paddleArc: 0.4,
  paddleSpeed: 2.7,
  paddleAcceleration: 14,
  paddleBraking: 18,
  ballRadius: 10,
  ballStartSpeed: 315,
  hitMultiplier: 1.025,
  ballMaxSpeed: 610,
  paddleInfluence: 32,
  contactInfluence: 105,
  servePreviewTicks: 51,
  pointPauseTicks: 54,
  resetPauseTicks: 18,
  scoreToWin: 7,
});

const TAU = Math.PI * 2;
const DT = 1 / CONFIG.tickRate;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const wrap = (angle) => ((angle % TAU) + TAU) % TAU;
const angleDiff = (target, current) => {
  let value = wrap(target) - wrap(current);
  if (value <= -Math.PI) value += TAU;
  if (value > Math.PI) value -= TAU;
  return value;
};
const approach = (current, target, amount) => current < target
  ? Math.min(target, current + amount)
  : Math.max(target, current - amount);
const normalize = (x, y, fallbackX = 1, fallbackY = 0) => {
  const length = Math.hypot(x, y);
  return length > Number.EPSILON ? { x: x / length, y: y / length } : { x: fallbackX, y: fallbackY };
};

function nextRandom(state) {
  let value = state.rngState | 0;
  value = (value + 0x6d2b79f5) | 0;
  let mixed = value;
  mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
  state.rngState = value;
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
}

function segmentCircle(start, end, radius) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const a = dx * dx + dy * dy;
  if (a <= Number.EPSILON) return null;
  const b = 2 * (start.x * dx + start.y * dy);
  const c = start.x * start.x + start.y * start.y - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const near = (-b - root) / (2 * a);
  const far = (-b + root) / (2 * a);
  const t = near >= 0 ? near : far >= 0 ? far : null;
  return t !== null && t <= 1 ? { x: start.x + dx * t, y: start.y + dy * t } : null;
}

export function createState(seed = 1, players = []) {
  return {
    tick: 0,
    rngState: Number(seed) | 0,
    phase: "IDLE",
    phaseTicks: 0,
    roundIndex: 0,
    winnerId: null,
    players: players.map((player, index) => ({
      id: String(player.playerId || `guest-${index + 1}`),
      displayName: String(player.displayName || `Player ${index + 1}`).slice(0, 18),
      color: index === 0 ? "#48e6ff" : "#ff4fd8",
      score: 0,
    })),
    paddles: players.map((player, index) => ({
      id: `paddle-${index + 1}`,
      playerId: String(player.playerId || `guest-${index + 1}`),
      angle: index === 0 ? Math.PI : Math.PI * 1.5,
      previousAngle: index === 0 ? Math.PI : Math.PI * 1.5,
      angularVelocity: 0,
      arc: CONFIG.paddleArc,
    })),
    ball: {
      x: 0, y: 0, previousX: 0, previousY: 0, vx: 0, vy: 0,
      radius: CONFIG.ballRadius, speed: CONFIG.ballStartSpeed, lastTouchPlayerId: null,
    },
    servePlan: null,
  };
}

function planServe(state) {
  const receiverIndex = state.roundIndex % 2;
  const receiver = state.paddles[receiverIndex];
  const time = (CONFIG.arenaRadius - CONFIG.ballRadius) / CONFIG.ballStartSpeed;
  const reachableArc = CONFIG.paddleSpeed * time;
  const maximum = reachableArc * 0.72;
  const minimum = Math.min(0.32, maximum);
  const direction = nextRandom(state) < 0.5 ? -1 : 1;
  const travel = minimum + (maximum - minimum) * (0.35 + nextRandom(state) * 0.5);
  const targetAngle = wrap(receiver.angle + direction * travel);
  return {
    receiverIndex,
    receiverPlayerId: receiver.playerId,
    targetAngle,
    angularTravel: direction * travel,
    reachableArc,
    velocity: {
      x: Math.cos(targetAngle) * CONFIG.ballStartSpeed,
      y: Math.sin(targetAngle) * CONFIG.ballStartSpeed,
    },
  };
}

function beginServe(state) {
  state.servePlan = planServe(state);
  state.phase = "SERVE_PREVIEW";
  state.phaseTicks = CONFIG.servePreviewTicks;
  Object.assign(state.ball, {
    x: 0, y: 0, previousX: 0, previousY: 0, vx: 0, vy: 0,
    speed: CONFIG.ballStartSpeed, lastTouchPlayerId: null,
  });
}

export function startState(state) {
  state.players.forEach((player) => { player.score = 0; });
  state.roundIndex = 0;
  state.winnerId = null;
  beginServe(state);
}

function updatePaddles(state, commands) {
  state.paddles.forEach((paddle, index) => {
    const orbit = Math.sign(clamp(Number(commands[index]?.orbit) || 0, -1, 1));
    const target = orbit * CONFIG.paddleSpeed;
    const rate = orbit === 0 ? CONFIG.paddleBraking : CONFIG.paddleAcceleration;
    paddle.previousAngle = paddle.angle;
    paddle.angularVelocity = approach(paddle.angularVelocity, target, rate * DT);
    paddle.angle = wrap(paddle.angle + paddle.angularVelocity * DT);
  });
}

function findPaddle(state, contactAngle) {
  const ballArc = Math.asin(clamp(CONFIG.ballRadius / CONFIG.arenaRadius, 0, 1));
  let best = null;
  for (const paddle of state.paddles) {
    const offset = angleDiff(contactAngle, paddle.angle);
    const halfArc = paddle.arc / 2 + ballArc;
    if (Math.abs(offset) <= halfArc && (!best || Math.abs(offset) < Math.abs(best.offset))) {
      best = { paddle, offset, halfArc };
    }
  }
  return best;
}

function returnBall(state, hit, contact) {
  const normal = normalize(hit.x, hit.y);
  const tangent = { x: -normal.y, y: normal.x };
  const dot = state.ball.vx * normal.x + state.ball.vy * normal.y;
  let vx = state.ball.vx - 2 * dot * normal.x;
  let vy = state.ball.vy - 2 * dot * normal.y;
  const offset = clamp(contact.offset / contact.halfArc, -1, 1);
  const tangentSpeed = offset * CONFIG.contactInfluence + contact.paddle.angularVelocity * CONFIG.paddleInfluence;
  vx += tangent.x * tangentSpeed;
  vy += tangent.y * tangentSpeed;
  const direction = normalize(vx, vy, -normal.x, -normal.y);
  const speed = Math.min(CONFIG.ballMaxSpeed, Math.max(state.ball.speed, Math.hypot(state.ball.vx, state.ball.vy)) * CONFIG.hitMultiplier);
  const safeRadius = CONFIG.arenaRadius - CONFIG.ballRadius - 0.5;
  Object.assign(state.ball, {
    x: normal.x * safeRadius,
    y: normal.y * safeRadius,
    vx: direction.x * speed,
    vy: direction.y * speed,
    speed,
    lastTouchPlayerId: contact.paddle.playerId,
  });
}

function awardPoint(state, events, ownerId) {
  const player = state.players.find((entry) => entry.id === ownerId);
  if (!player) return;
  player.score += 1;
  events.push({ type: "POINT_SCORED", playerId: ownerId, score: player.score });
  if (player.score >= CONFIG.scoreToWin) {
    state.phase = "MATCH_OVER";
    state.winnerId = ownerId;
    events.push({ type: "MATCH_ENDED", winnerId: ownerId });
  } else {
    state.phase = "POINT_SCORED";
    state.phaseTicks = CONFIG.pointPauseTicks;
  }
}

function escape(state, events) {
  const ownerId = state.ball.lastTouchPlayerId;
  if (!ownerId) {
    state.phase = "ROUND_RESET";
    state.phaseTicks = CONFIG.resetPauseTicks;
    return;
  }
  awardPoint(state, events, ownerId);
}

function doubleTouch(state, events, playerId) {
  const opponent = state.players.find((player) => player.id !== playerId);
  if (!opponent) return;
  awardPoint(state, events, opponent.id);
  events.push({ type: "DOUBLE_TOUCH_FAULT", playerId, awardedPlayerId: opponent.id });
}

function updateBall(state, events) {
  const ball = state.ball;
  const start = { x: ball.x, y: ball.y };
  const end = { x: ball.x + ball.vx * DT, y: ball.y + ball.vy * DT };
  ball.previousX = start.x;
  ball.previousY = start.y;
  const outward = start.x * ball.vx + start.y * ball.vy >= 0;
  const hit = outward ? segmentCircle(start, end, CONFIG.arenaRadius - CONFIG.ballRadius) : null;
  if (!hit) {
    ball.x = end.x;
    ball.y = end.y;
    return;
  }
  const contact = findPaddle(state, Math.atan2(hit.y, hit.x));
  if (contact) {
    if (contact.paddle.playerId === ball.lastTouchPlayerId) {
      ball.x = end.x;
      ball.y = end.y;
      doubleTouch(state, events, contact.paddle.playerId);
    } else returnBall(state, hit, contact);
  }
  else {
    ball.x = end.x;
    ball.y = end.y;
    escape(state, events);
  }
}

export function stepState(state, commands) {
  const events = [];
  state.tick += 1;
  if (state.phase !== "IDLE" && state.phase !== "MATCH_OVER") updatePaddles(state, commands);
  if (state.phase === "PLAYING") updateBall(state, events);
  if (state.phaseTicks > 0) state.phaseTicks -= 1;
  if (state.phase === "SERVE_PREVIEW" && state.phaseTicks <= 0) {
    state.phase = "PLAYING";
    state.ball.vx = state.servePlan.velocity.x;
    state.ball.vy = state.servePlan.velocity.y;
  } else if (state.phase === "POINT_SCORED" && state.phaseTicks <= 0) {
    state.phase = "ROUND_RESET";
    state.phaseTicks = CONFIG.resetPauseTicks;
  } else if (state.phase === "ROUND_RESET" && state.phaseTicks <= 0) {
    state.roundIndex += 1;
    beginServe(state);
  }
  return events;
}
