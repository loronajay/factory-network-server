// Copied to games/puckd-up/puckd-up.test.mjs in Factory Network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleClientMessage, handleClientDisconnect } from '../../src/router.mjs';
import { clients, lobbies, clientLobbies } from '../../src/state.mjs';
import { lobbyGame } from '../registry.mjs';

function peer(id) {
    const ws = { OPEN: 1, readyState: 1, payloads: [], send(raw) { this.payloads.push(JSON.parse(raw)); } };
    clients.set(id, ws);
    return { ws, send: data => handleClientMessage(id, ws, JSON.stringify(data)) };
}
const request = { type: 'find_lobby', gameId: 'puckd-up', minPlayers: 2, maxPlayers: 2, settings: { protocolVersion: 2, targetScore: 7 } };
const ready = { type: 'lobby_message', messageType: 'puck_ready', value: JSON.stringify({ protocolVersion: 2, ready: true }) };

test('real registry starts only after both ready and never relays forged puck/results', () => {
    const a = peer('puck-a'), b = peer('puck-b');
    try {
        a.send(request); b.send(request);
        const lobby = lobbies.get(clientLobbies.get('puck-a'));
        a.send({ type: 'start_lobby' }); assert.equal(lobby.status, 'open');
        b.send(ready); assert.equal(lobby.status, 'open');
        a.send(ready); assert.equal(lobby.status, 'started');
        assert.ok(lobby.puck);
        const start = a.ws.payloads.find(p => p.event === 'lobby_started');
        assert.equal(start.authorityMode, 'server');
        assert.deepEqual(start.matchState.seats, ['puck-a', 'puck-b']);
        a.send({ type: 'lobby_message', messageType: 'match_result', value: '{"winner":"puck-a"}' });
        assert.equal(a.ws.payloads.at(-1).code, 'PUCK_REJECTED');
        assert.equal(b.ws.payloads.some(p => p.messageType === 'match_result'), false);
        assert.deepEqual(lobby.puck.snapshot().scores, [0, 0]);
        a.send({ type: 'leave_lobby' });
        assert.equal(lobby.puck.snapshot().reason, 'forfeit');
        assert.equal(lobby.puck.snapshot().winner, 1);
        assert.equal(lobby.puckTimer, null);
        b.send({ type: 'leave_lobby' }); assert.equal(lobbies.has(lobby.roomCode), false);
    } finally { for (const id of ['puck-a', 'puck-b']) handleClientDisconnect(id, 'test'); }
});

test('private lobbies cap at two, reject wrong-game joins and transfer owner', () => {
    const a = peer('puck-a'), b = peer('puck-b'), c = peer('puck-c');
    try {
        a.send({ ...request, type: 'create_lobby', private: true, maxPlayers: 8 });
        const code = clientLobbies.get('puck-a'); assert.equal(lobbies.get(code).maxPlayers, 2);
        b.send(request); assert.notEqual(clientLobbies.get('puck-b'), code);
        const old = clientLobbies.get('puck-b');
        b.send({ type: 'join_lobby', gameId: 'wrong-game', roomCode: code }); assert.equal(clientLobbies.get('puck-b'), old);
        b.send({ type: 'join_lobby', gameId: 'puckd-up', roomCode: code });
        c.send({ type: 'join_lobby', gameId: 'puckd-up', roomCode: code }); assert.equal(c.ws.payloads.at(-1).code, 'LOBBY_FULL');
        b.send(ready); a.send({ type: 'leave_lobby' });
        assert.equal(lobbies.get(code).ownerId, 'puck-b');
        assert.equal(lobbyGame('puckd-up').canStart(lobbies.get(code)), false);
        b.send({ type: 'leave_lobby' }); assert.equal(lobbies.has(code), false);
    } finally { for (const id of ['puck-a', 'puck-b', 'puck-c']) handleClientDisconnect(id, 'test'); }
});
