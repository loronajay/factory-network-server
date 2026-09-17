import { randomUUID } from 'node:crypto';
import { createAuthority } from './authority.js';
import { createFixedStep } from '../scripts/core/fixed-step.js';
import { isPlayerColor, PROTOCOL_VERSION, RECONNECT_MS, SNAPSHOT_HZ } from '../scripts/online/protocol.js';

const TICKS_PER_SNAPSHOT = 240 / SNAPSHOT_HZ, IDLE_PUBLISH_MS = 250;

// Game-specific adapter for the existing generic Factory Network lobby hooks.
export function createLobbyGame({ CANNON, broadcast, update, now = Date.now, schedule = setInterval, cancel = clearInterval, makeAuthority = createAuthority }) {
    function publish(lobby) {
        if (!lobby.puck) return;
        const snapshot = lobby.puck.snapshot();
        if (snapshot.phase === 'finished') { lobby.status = 'ended'; stopTimer(lobby); }
        broadcast(lobby.roomCode, { event: 'puck_state', roomCode: lobby.roomCode,
            snapshot: { ...snapshot, rematch: snapshot.seats.map(id => lobby.puckRematch?.has(id) || false) } });
    }
    function stopTimer(lobby) {
        if (lobby.puckTimer != null) cancel(lobby.puckTimer);
        lobby.puckTimer = null;
    }
    function init(lobby, startAt) {
        stopTimer(lobby); lobby.puck?.dispose();
        const seats = [...lobby.members];
        const colors = seats.map(id => lobby.publicPlayerFields?.get(id)?.playerColor);
        lobby.puck = makeAuthority({ CANNON, matchId: randomUUID(), seats, colors });
        lobby.puckRematch = new Set();
        lobby.status = 'started'; lobby.startAt = startAt;
    }
    function run(lobby) {
        stopTimer(lobby);
        let last = now(), lastPublish = last, ticks = 0, publishedTick = 0;
        const clock = createFixedStep(dt => { lobby.puck.tick(dt); ticks++; });
        // Snapshots are paced by simulated ticks, not by the timer's remainder:
        // an 8 ms timer against a wall-clock interval alternates 32/40 ms gaps,
        // and clients pace their playback off the tick numbers those carry.
        // The idle heartbeat keeps a paused match (pre-start, reconnect grace)
        // inside the clients' stall watchdog.
        lobby.puckTimer = schedule(() => {
            const current = now();
            lobby.puck.expire(current);
            if (current >= lobby.startAt) clock.advance(Math.max(0, current - Math.max(last, lobby.startAt)) / 1000);
            last = current;
            if (ticks - publishedTick >= TICKS_PER_SNAPSHOT || current - lastPublish >= IDLE_PUBLISH_MS) {
                publishedTick = ticks; lastPublish = current; publish(lobby);
            }
        }, 4);
        lobby.puckTimer?.unref?.();
    }
    function begin(lobby) {
        init(lobby, now() + 1000);
        broadcast(lobby.roomCode, { event: 'lobby_started', gameId: 'puckd-up', roomCode: lobby.roomCode,
            authorityMode: 'server', matchState: lobby.puck.snapshot() });
        run(lobby);
    }
    const game = {
        gameId: 'puckd-up', lobbyLimits: { minPlayers: 2, maxPlayers: 2 }, reconnectGracePeriodMs: RECONNECT_MS,
        canStart: lobby => lobby.members.size === 2 && lobby.settings?.protocolVersion === PROTOCOL_VERSION
            && [...lobby.members].every(id => lobby.publicPlayerFields?.get(id)?.ready === true),
        initMatch: init, afterStart: run,
        startedPayloadExtras: lobby => ({ authorityMode: 'server', matchState: lobby.puck.snapshot() }),
        hasActiveMatch: lobby => !!lobby.puck,
        clearTimers(lobby) { stopTimer(lobby); lobby.puck?.dispose(); },
        applyDisconnect(lobby, id, time) {
            // Open-lobby departures invalidate readiness before a replacement joins.
            if (!lobby.puck) {
                lobby.publicPlayerFields = new Map();
                return false;
            }
            lobby.puck.disconnect(id, time, !lobby.members.has(id));
            return true;
        },
        applyReconnect(lobby, id, time) { return lobby.puck?.reconnect(id, time) || false; },
        broadcastAfterLeave: publish,
        broadcastAfterReconnect: publish,
        handleMessage(lobby, id, type, raw) {
            const rejected = message => ({ handled: true, error: { code: 'PUCK_REJECTED', message } });
            if (!lobby.members.has(id)) return rejected('Not seated in this lobby.');
            let value;
            try { value = JSON.parse(raw); } catch { return rejected('Invalid multiplayer message.'); }
            if (type === 'puck_ready' && lobby.status === 'open') {
                if (value?.protocolVersion !== PROTOCOL_VERSION || lobby.settings?.protocolVersion !== PROTOCOL_VERSION)
                    return rejected('Multiplayer version mismatch. Update both clients and create a new lobby.');
                if (!isPlayerColor(value.playerColor)) return rejected('Choose a valid custom player color.');
                lobby.publicPlayerFields ||= new Map();
                lobby.publicPlayerFields.set(id, { ready: value.ready === true, protocolVersion: PROTOCOL_VERSION, playerColor: value.playerColor });
                if (game.canStart(lobby)) begin(lobby);
                else update(lobby);
                return { handled: true };
            }
            if (type === 'puck_input') { lobby.puck?.input(id, value); return { handled: true }; }
            if (type === 'puck_rematch' && lobby.status === 'ended' && value?.matchId === lobby.puck?.snapshot().matchId) {
                if (lobby.members.size !== 2 || lobby.puck.snapshot().reason === 'forfeit') return rejected('Opponent left. Return to the lobby for another match.');
                lobby.puckRematch.add(id);
                if ([...lobby.members].every(member => lobby.puckRematch.has(member))) begin(lobby);
                else publish(lobby);
                return { handled: true };
            }
            return rejected('Unsupported multiplayer action.');
        },
    };
    return game;
}
