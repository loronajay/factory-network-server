// Game registry — the single index of everything the server knows about a game.
//
// Every game is described by a uniform Game Definition exported from
// games/<id>/server/<id>.game.mjs:
//
//   {
//     id?        : exact gameId this definition handles
//     matches?   : (gameId) => boolean   // for families / variants (prefixes, -ranked)
//     matchmaking: { strategy, sides? }  // "side-pair" | "symmetric-balanced" | "lobby" | "self-owned"
//     matchSettings?(seed) -> object|null // deterministic server-owned match config
//     lobbyGame? : lobby game-module      // see src/lobby.mjs (lobby-based games)
//     bridge?    : { create(ctx), shouldRoute(clientId, data, instance) } // self-owning games
//   }
//
// Generic code (src/*) never names a game; it asks the registry. A gameId with no
// definition falls back to plain relay + the default side-pair strategy.
import { rooms, lobbies } from "../src/state.mjs";
import { makeRoomCode, sendToClient } from "../src/transport.mjs";

import { definition as circuitSiege } from "./circuit-siege/server/circuit-siege.game.mjs";
import { definition as echoDuel } from "./echo-duel/server/echo-duel.game.mjs";
import { definition as buildBuddy } from "./build-buddy/server/build-buddy.game.mjs";
import { definition as sumorai } from "./sumorai/server/sumorai.game.mjs";
import { definition as creatureBattler } from "./creature-battler/server/creature-battler.game.mjs";
import { definition as cockpitSwarm } from "./cockpit-swarm/server/cockpit-swarm.game.mjs";
import { definition as miniTactics } from "./mini-tactics/server/mini-tactics.game.mjs";
import { definition as tacticalArena } from "./tactical-arena/server/tactical-arena.game.mjs";
import { definition as potOfGreed } from "./pot-of-greed/server/pot-of-greed.game.mjs";
import { definition as questionableDecisions } from "./questionable-decisions/server/questionable-decisions.game.mjs";

const DEFAULT_MATCHMAKING = { strategy: "side-pair" };

// Built on first use. (Adapters import the leaf src/lobby-bus.mjs, not the full
// src/lobby.mjs, so this registry is no longer part of an import cycle; the lazy
// build is kept as cheap insurance against future cycles.)
let definitions = null;
function allDefinitions() {
  if (!definitions) {
    definitions = [circuitSiege, echoDuel, buildBuddy, sumorai, creatureBattler, cockpitSwarm, miniTactics, tacticalArena, potOfGreed, questionableDecisions];
  }
  return definitions;
}

function findDefinition(gameId) {
  if (!gameId) return null;
  for (const def of allDefinitions()) {
    if (def.id === gameId) return def;
    if (typeof def.matches === "function" && def.matches(gameId)) return def;
  }
  return null;
}

// --- queries used by generic code ---
export function lobbyGame(gameId) {
  return findDefinition(gameId)?.lobbyGame || null;
}

export function matchmakingStrategy(gameId) {
  return findDefinition(gameId)?.matchmaking || DEFAULT_MATCHMAKING;
}

export function matchSettings(gameId, seed) {
  const def = findDefinition(gameId);
  return def?.matchSettings ? (def.matchSettings(seed) ?? null) : null;
}

// --- self-owning bridges ---
let bridges = null; // [{ def, instance }]
function ensureBridges() {
  if (bridges) return bridges;
  bridges = [];

  // Collision-free room code across the generic rooms/lobbies and every bridge.
  const createRoomCode = () => {
    let code = makeRoomCode();
    while (rooms.has(code) || lobbies.has(code) || bridges.some(({ instance }) => instance.hasRoomCode?.(code))) {
      code = makeRoomCode();
    }
    return code;
  };
  const ctx = { createRoomCode, sendToClient, now: () => Date.now() };

  for (const def of allDefinitions()) {
    if (!def.bridge?.create) continue;
    bridges.push({ def, instance: def.bridge.create(ctx) });
  }
  return bridges;
}

// Returns the bridge instance that should handle this message, or null.
export function routeToBridge(clientId, data) {
  for (const { def, instance } of ensureBridges()) {
    if (def.bridge.shouldRoute(clientId, data, instance)) return instance;
  }
  return null;
}

// Returns the bridge instance that currently owns this client, or null.
export function bridgeOwningClient(clientId) {
  for (const { instance } of ensureBridges()) {
    if (instance.ownsClient?.(clientId)) return instance;
  }
  return null;
}

let heartbeat = null;
export function startBridgeHeartbeats(intervalMs = 250) {
  if (heartbeat) return heartbeat;
  heartbeat = setInterval(() => {
    for (const { instance } of ensureBridges()) instance.tickActiveRooms?.();
  }, intervalMs);
  if (typeof heartbeat.unref === "function") heartbeat.unref();
  return heartbeat;
}
