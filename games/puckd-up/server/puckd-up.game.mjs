// Installed into factory-network-server/games/puckd-up/server by sync-server.mjs.
// Reuse its already-vendored Cannon 0.20 runtime; no new runtime dependency.
import * as CANNON from '../../yam-bowling/shared/bowl3d/vendor/cannon-es.mjs';
import { broadcastToLobby, sendLobbyUpdated } from '../../../src/lobby-bus.mjs';
import { createLobbyGame } from './lobby-game.js';

export const definition = {
    id: 'puckd-up', matchmaking: { strategy: 'lobby' },
    lobbyGame: createLobbyGame({ CANNON, broadcast: broadcastToLobby, update: sendLobbyUpdated }),
};
