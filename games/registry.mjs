// Game registry. Two integration styles live behind one front door:
//
//   1. Lobby games (Echo Duel, Build Buddy) plug into the shared v2 lobby
//      lifecycle via the lobby game-module interface (see src/lobby.mjs).
//   2. Self-owning bridges (Circuit Siege) own their own rooms/queues and
//      intercept messages directly.
//
// The circuit-siege bridge is initialized lazily so importing this module (e.g.
// from a unit test) does not spin up its dynamic imports or heartbeat.
import { rooms, lobbies, CIRCUIT_SIEGE_GAME_ID } from "../src/state.mjs";
import { makeRoomCode, sendToClient } from "../src/transport.mjs";
import { echoDuelLobbyGame } from "./echo-duel/server/echo-duel-lobby-game.mjs";
import { buildBuddyLobbyGame } from "./build-buddy/server/build-buddy-lobby-game.mjs";

// Built lazily: the lobby-game adapters and src/lobby.mjs import each other, so
// the adapter bindings are still in their temporal dead zone while this module
// is first evaluated. Deferring the lookup until first call sidesteps the cycle.
let lobbyGames = null;
function ensureLobbyGames() {
  if (!lobbyGames) {
    lobbyGames = new Map([
      [echoDuelLobbyGame.gameId, echoDuelLobbyGame],
      [buildBuddyLobbyGame.gameId, buildBuddyLobbyGame],
    ]);
  }
  return lobbyGames;
}

// Returns the lobby game-module for a gameId, or null for generic lobbies.
export function lobbyGame(gameId) {
  return ensureLobbyGames().get(gameId) || null;
}

// --- Circuit Siege self-owning bridge (lazy) ---
let circuitSiegeBridgeRef = null;
let circuitSiegeBridgePromise = null;

export function getCircuitSiegeBridge() {
  if (!circuitSiegeBridgePromise) {
    circuitSiegeBridgePromise = Promise.all([
      import("./circuit-siege/server/board-catalog.mjs"),
      import("./circuit-siege/server/circuit-siege-server-bridge.mjs"),
    ]).then(([catalogModule, bridgeModule]) => {
      const boardCatalog = catalogModule.createBoardCatalog();
      const bridge = bridgeModule.createCircuitSiegeServerBridge({
        selectBoard() {
          return boardCatalog.selectBoard();
        },
        now: () => Date.now(),
        createRoomCode() {
          let code = makeRoomCode();
          while (rooms.has(code) || lobbies.has(code) || circuitSiegeBridgeRef?.hasRoomCode?.(code)) {
            code = makeRoomCode();
          }
          return code;
        },
        sendToClient,
      });
      circuitSiegeBridgeRef = bridge;
      return bridge;
    });
  }
  return circuitSiegeBridgePromise;
}

let circuitSiegeHeartbeat = null;
export function startCircuitSiegeHeartbeat(intervalMs = 250) {
  if (circuitSiegeHeartbeat) return circuitSiegeHeartbeat;
  circuitSiegeHeartbeat = setInterval(async () => {
    const bridge = await getCircuitSiegeBridge();
    bridge.tickActiveRooms?.();
  }, intervalMs);
  if (typeof circuitSiegeHeartbeat.unref === "function") circuitSiegeHeartbeat.unref();
  return circuitSiegeHeartbeat;
}

export async function shouldRouteToCircuitSiege(clientId, data) {
  const type = String(data?.type || "");
  const gameId = String(data?.gameId || "");
  const bridge = await getCircuitSiegeBridge();

  if (type === "find_match" || type === "queue_status" || type === "create_room") {
    return gameId === CIRCUIT_SIEGE_GAME_ID;
  }

  if (type === "join_room") {
    if (gameId === CIRCUIT_SIEGE_GAME_ID) {
      return true;
    }

    const roomCode = String(data?.roomCode || "").trim().toUpperCase();
    return roomCode ? bridge.hasRoomCode(roomCode) : false;
  }

  if (type === "cancel_match" || type === "room_message" || type === "leave_room") {
    return bridge.ownsClient(clientId);
  }

  return false;
}
