export const NPC_WALK_BOUNDS = Object.freeze({
  minX: 120,
  maxX: 1160,
});

export const NPC_BASELINE_Y = 706;
export const NPC_FRAME_TICKS = 8;
export const NPC_SPAWN_DELAY_TICKS = 6;
export const NPC_WAVE_WAIT_TICKS = 60;
export const POOP_HITBOX = Object.freeze({
  width: 48,
  height: 62,
});

export const NPC_DEFINITIONS = Object.freeze({
  alan: {
    score: 1,
    speed: 4,
    sound: "alan",
    y: NPC_BASELINE_Y,
    startX: 190,
    direction: 1,
    scale: 0.42,
    bounds: NPC_WALK_BOUNDS,
    frames: ["alan-1.png", "alan-2.png", "alan-3.png", "alan-4.png"],
    poseFrames: [],
    hitbox: { width: 60, height: 155, offsetY: -78 },
  },
  john: {
    score: 1,
    speed: 3,
    sound: "john",
    y: NPC_BASELINE_Y,
    startX: 1090,
    direction: -1,
    scale: 0.42,
    bounds: NPC_WALK_BOUNDS,
    frames: ["john-1.png", "john-2.png", "john-3.png", "john-4.png"],
    poseFrames: [],
    hitbox: { width: 60, height: 155, offsetY: -78 },
  },
  bryan: {
    score: 2,
    speed: 8,
    sound: "bryan",
    y: NPC_BASELINE_Y,
    startX: 560,
    direction: 1,
    scale: 0.3,
    bounds: NPC_WALK_BOUNDS,
    frames: ["bryan-1.png", "bryan-2.png", "bryan-3.png"],
    poseFrames: [],
    hitbox: { width: 95, height: 160, offsetY: -80 },
  },
  anna: {
    score: 2,
    speed: 9,
    sound: "anna",
    y: NPC_BASELINE_Y,
    startX: 730,
    direction: 1,
    scale: 0.28,
    bounds: NPC_WALK_BOUNDS,
    frames: ["anna-1.png", "anna-2.png", "anna-3.png", "anna-4.png"],
    poseFrames: ["anna-pose-a-1.png", "anna-pose-a-2.png", "anna-pose-b-1.png", "anna-pose-b-2.png"],
    poseDurationTicks: 72,
    hitbox: { width: 105, height: 165, offsetY: -82 },
  },
  sanjeet: {
    score: 3,
    speed: 9,
    sound: "sanjeet",
    y: NPC_BASELINE_Y,
    startX: 950,
    direction: 1,
    scale: 0.42,
    bounds: NPC_WALK_BOUNDS,
    frames: ["sanjeet-1.png", "sanjeet-2.png", "sanjeet-3.png", "sanjeet-4.png"],
    poseFrames: ["sanjeet-pose-1.png", "sanjeet-pose-2.png"],
    poseDurationTicks: 42,
    hitbox: { width: 75, height: 150, offsetY: -75 },
  },
  sanjeetFast: {
    score: 5,
    speed: 14,
    sound: "sanjeetFast",
    y: NPC_BASELINE_Y,
    startX: 1040,
    direction: -1,
    scale: 0.42,
    bounds: NPC_WALK_BOUNDS,
    frames: ["sanjeet-1.png", "sanjeet-2.png", "sanjeet-3.png", "sanjeet-4.png"],
    poseFrames: ["sanjeet-pose-1.png", "sanjeet-pose-2.png"],
    poseDurationTicks: 42,
    hitbox: { width: 75, height: 150, offsetY: -75 },
  },
});

export const FIRST_WAVE = Object.freeze(["alan", "anna", "john", "sanjeet", "sanjeetFast", "john"]);
export const REFRESH_WAVE = Object.freeze([
  "alan",
  "anna",
  "john",
  "sanjeet",
  "sanjeet",
  "bryan",
  "wait",
  "bryan",
  "sanjeetFast",
  "bryan",
  "sanjeetFast",
  "alan",
  "alan",
  "john",
]);

export const HOTSEAT_ROUND_WAVES = Object.freeze({
  1: Object.freeze({
    first: Object.freeze(["alan", "anna", "john", "sanjeet"]),
    refresh: Object.freeze(["alan", "anna", "john", "sanjeet", "sanjeetFast", "john"]),
  }),
  2: Object.freeze({
    first: Object.freeze(["alan", "anna", "john", "sanjeet", "bryan", "sanjeetFast"]),
    refresh: Object.freeze(["alan", "anna", "john", "sanjeet", "bryan", "sanjeetFast", "bryan", "anna"]),
  }),
  3: Object.freeze({
    first: Object.freeze(["alan", "anna", "john", "sanjeet", "wait", "alan", "anna", "john", "sanjeetFast"]),
    refresh: Object.freeze([
      "alan",
      "anna",
      "john",
      "sanjeet",
      "sanjeet",
      "bryan",
      "wait",
      "bryan",
      "sanjeetFast",
      "bryan",
      "sanjeetFast",
    ]),
  }),
});

function resolveWaveSet(options = {}) {
  const requestedRound = Number(options.round);
  const round = Number.isFinite(requestedRound) && requestedRound > 0
    ? Math.max(1, Math.min(3, Math.floor(requestedRound)))
    : 0;
  const hotseatWaves = HOTSEAT_ROUND_WAVES[round];
  if (hotseatWaves) {
    return {
      firstWave: hotseatWaves.first,
      refreshWave: hotseatWaves.refresh,
    };
  }
  return {
    firstWave: FIRST_WAVE,
    refreshWave: REFRESH_WAVE,
  };
}

export function createNpcWaveState(queue = FIRST_WAVE) {
  return {
    queue: [...queue],
    delayTicks: 0,
  };
}

export function createNpcState(options = {}) {
  const waveSet = resolveWaveSet(options);
  return {
    entities: [],
    wave: createNpcWaveState([]),
    waveIndex: 0,
    nextId: 1,
    firstWave: waveSet.firstWave,
    refreshWave: waveSet.refreshWave,
  };
}

export function startNextWave(state) {
  const queue = state.waveIndex === 0
    ? state.firstWave || FIRST_WAVE
    : state.refreshWave || REFRESH_WAVE;
  return {
    ...state,
    wave: createNpcWaveState(queue),
    waveIndex: state.waveIndex + 1,
  };
}

export function createNpcEntity(type, id) {
  const def = NPC_DEFINITIONS[type];
  if (!def) throw new Error(`Unknown Bird Duty NPC type: ${type}`);
  return {
    id,
    type,
    x: def.startX,
    y: def.y,
    direction: def.direction,
    animationTick: 0,
    poseTicks: 0,
  };
}

function updateNpcEntity(entity) {
  const def = NPC_DEFINITIONS[entity.type];
  const animationTick = entity.animationTick + 1;

  if (entity.poseTicks > 0) {
    return {
      ...entity,
      animationTick,
      poseTicks: entity.poseTicks - 1,
    };
  }

  let x = entity.x + def.speed * entity.direction;
  let direction = entity.direction;
  let poseTicks = 0;

  if (x >= def.bounds.maxX) {
    x = def.bounds.maxX;
    direction = -1;
    poseTicks = def.poseDurationTicks || 0;
  } else if (x <= def.bounds.minX) {
    x = def.bounds.minX;
    direction = 1;
    poseTicks = def.poseDurationTicks || 0;
  }

  return {
    ...entity,
    x,
    direction,
    animationTick,
    poseTicks,
  };
}

function updateWaveSpawner(state) {
  if (state.wave.delayTicks > 0) {
    return {
      ...state,
      wave: {
        ...state.wave,
        delayTicks: state.wave.delayTicks - 1,
      },
    };
  }

  if (state.wave.queue.length === 0) return state;

  const [nextSpawn, ...queue] = state.wave.queue;
  if (nextSpawn === "wait") {
    return {
      ...state,
      wave: {
        queue,
        delayTicks: NPC_WAVE_WAIT_TICKS,
      },
    };
  }

  return {
    ...state,
    nextId: state.nextId + 1,
    entities: [...state.entities, createNpcEntity(nextSpawn, state.nextId)],
    wave: {
      queue,
      delayTicks: NPC_SPAWN_DELAY_TICKS,
    },
  };
}

export function updateNpcState(state) {
  let next = state.waveIndex === 0 ? startNextWave(state) : state;
  next = updateWaveSpawner(next);
  next = {
    ...next,
    entities: next.entities.map(updateNpcEntity),
  };

  if (next.wave.queue.length === 0 && next.wave.delayTicks === 0 && next.entities.length === 0) {
    next = startNextWave(next);
  }

  return next;
}

// Guest clients in an online match receive host snapshots at a lower rate than
// the 60hz tick. They advance the entities they already have so motion stays
// smooth between snapshots, without running the spawner or resolving any hits.
export function advanceNpcEntities(entities = []) {
  return entities.map(updateNpcEntity);
}

export function getNpcHitbox(entity) {
  const def = NPC_DEFINITIONS[entity.type];
  return {
    x: entity.x - def.hitbox.width / 2,
    y: entity.y + def.hitbox.offsetY,
    width: def.hitbox.width,
    height: def.hitbox.height,
  };
}

function pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function getPoopHitbox(poop) {
  return {
    x: poop.x - POOP_HITBOX.width / 2,
    y: poop.y - POOP_HITBOX.height / 2,
    width: POOP_HITBOX.width,
    height: POOP_HITBOX.height,
  };
}

export function processNpcHits(entities, poop) {
  if (poop?.phase !== "airborne") {
    return {
      entities,
      scoreDelta: 0,
      hitTypes: [],
    };
  }

  let scoreDelta = 0;
  const hitTypes = [];
  const survivors = [];

  const poopHitbox = getPoopHitbox(poop);

  for (const entity of entities) {
    if (rectsOverlap(poopHitbox, getNpcHitbox(entity))) {
      scoreDelta += NPC_DEFINITIONS[entity.type].score;
      hitTypes.push(entity.type);
    } else {
      survivors.push(entity);
    }
  }

  return {
    entities: survivors,
    scoreDelta,
    hitTypes,
  };
}

export function getNpcFrameIndex(type, animationTick, poseTicks = 0) {
  const def = NPC_DEFINITIONS[type];
  const frames = poseTicks > 0 && def.poseFrames.length > 0 ? def.poseFrames : def.frames;
  return Math.floor(Math.max(0, animationTick | 0) / NPC_FRAME_TICKS) % frames.length;
}

export function getNpcFrameFile(type, animationTick, poseTicks = 0) {
  const def = NPC_DEFINITIONS[type];
  const frames = poseTicks > 0 && def.poseFrames.length > 0 ? def.poseFrames : def.frames;
  return `assets/scratch/pngs/${frames[getNpcFrameIndex(type, animationTick, poseTicks)]}`;
}
