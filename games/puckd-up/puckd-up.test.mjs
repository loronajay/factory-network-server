import test from 'node:test';
import assert from 'node:assert/strict';
import { handleClientMessage, handleClientDisconnect } from '../../src/router.mjs';
import { clients, lobbies, clientLobbies } from '../../src/state.mjs';
import { lobbyGame, matchmakingStrategy } from '../registry.mjs';

function peer(id) {
    const ws = { OPEN: 1, readyState: 1, payloads: [], send(raw) { this.payloads.push(JSON.parse(raw)); } };
    clients.set(id, ws);
    return { ws, send: data => handleClientMessage(id, ws, JSON.stringify(data)) };
}
const request = { type: 'find_lobby', gameId: 'puckd-up', minPlayers: 2, maxPlayers: 2, settings: { protocolVersion: 1, targetScore: 7 } };

test('registered staging lobbies pair two players but cannot launch or relay forged gameplay', () => {
    assert.equal(matchmakingStrategy('puckd-up').strategy, 'lobby');
    assert.deepEqual(lobbyGame('puckd-up').lobbyLimits, { minPlayers: 2, maxPlayers: 2 });
    const a = peer('puck-a'), b = peer('puck-b');
    try {
        a.send({ ...request, identity: { playerId: 'account-a', displayName: 'Alice' } });
        b.send({ ...request, identity: { playerId: 'account-b', displayName: 'Bob' } });
        const room = lobbies.get(clientLobbies.get('puck-a'));
        assert.equal(clientLobbies.get('puck-b'), room.roomCode);
        assert.equal(room.memberProfiles.get('puck-a').playerId, 'account-a');
        assert.equal(a.ws.payloads.at(-1).players[1].name, 'Bob');
        a.send({ type: 'start_lobby' });
        assert.equal(room.status, 'open');
        assert.equal(a.ws.payloads.at(-1).event, 'error');
        a.send({ type: 'lobby_message', messageType: 'match_result', value: JSON.stringify({ winner: 'puck-a' }) });
        assert.equal(a.ws.payloads.at(-1).code, 'ONLINE_NOT_READY');
        assert.equal(b.ws.payloads.some(p => p.messageType === 'match_result'), false);
    } finally { handleClientDisconnect('puck-a', 'test'); handleClientDisconnect('puck-b', 'test'); }
});

test('private lobbies stay out of search, cap at two, transfer owner and clean up', () => {
    const a = peer('puck-a'), b = peer('puck-b'), c = peer('puck-c');
    try {
        a.send({ ...request, type: 'create_lobby', private: true, maxPlayers: 8 });
        const code = clientLobbies.get('puck-a');
        assert.equal(lobbies.get(code).maxPlayers, 2);
        b.send(request);
        assert.notEqual(clientLobbies.get('puck-b'), code);
        b.send({ type: 'join_lobby', gameId: 'puckd-up', roomCode: code });
        c.send({ type: 'join_lobby', gameId: 'puckd-up', roomCode: code });
        assert.equal(c.ws.payloads.at(-1).code, 'LOBBY_FULL');
        a.send({ type: 'leave_lobby' });
        assert.equal(lobbies.get(code).ownerId, 'puck-b');
        b.send({ type: 'leave_lobby' });
        assert.equal(lobbies.has(code), false);
    } finally { for (const id of ['puck-a', 'puck-b', 'puck-c']) handleClientDisconnect(id, 'test'); }
});

test('wrong-game joins preserve the existing lobby; legacy code-only joins still work', () => {
    const a = peer('puck-a'), b = peer('puck-b');
    try {
        a.send({ ...request, type: 'create_lobby', private: true });
        const code = clientLobbies.get('puck-a');
        b.send({ ...request, gameId: 'mini-tactics', type: 'create_lobby' });
        const previous = clientLobbies.get('puck-b');
        b.send({ type: 'join_lobby', gameId: 'mini-tactics', roomCode: code });
        assert.equal(b.ws.payloads.at(-1).code, 'LOBBY_GAME_MISMATCH');
        assert.equal(clientLobbies.get('puck-b'), previous);
        assert.equal(lobbies.get(code).members.size, 1);
        b.send({ type: 'join_lobby', roomCode: code });
        assert.equal(clientLobbies.get('puck-b'), code);
    } finally { handleClientDisconnect('puck-a', 'test'); handleClientDisconnect('puck-b', 'test'); }
});
