import { createMatch } from '../scripts/core/match.js';
import { createSimulation } from '../scripts/physics/simulation.js';
import { updatePlayer } from '../scripts/input/player-motion.js';
import { FIXED_DT } from '../scripts/config.js';
import { clampTarget, PROTOCOL_VERSION, RECONNECT_MS } from '../scripts/online/protocol.js';

// The server alone runs Cannon and scoring. Seat IDs are socket-session bindings;
// account labels are not authentication or authority to write platform records.
export function createAuthority({ CANNON, bodies, matchId, seats, random = Math.random }) {
    let simulation, tick = 0, eventId = 0, winner = null, reason = '', disposed = false;
    const events = [], inputs = seats.map(() => ({ seq: 0, tick: -Infinity, target: null }));
    const disconnected = [0, 0];
    const emit = event => {
        simulation?.handle(event);
        if (event.type === 'match-end') winner = event.winner === 'player' ? 0 : 1;
        if (['round-reset', 'serve', 'goal', 'match-end', 'puck-hit', 'wall-hit', 'on-fire'].includes(event.type)) {
            events.push({ ...event, id: ++eventId });
            if (events.length > 64) events.shift();
        }
        if (event.type === 'round-reset') for (const input of inputs) input.target = null;
    };
    const match = createMatch({ emit });
    function targetFor(seat) {
        const input = inputs[seat];
        if (tick - input.tick > 60) input.target = null;
        return input.target;
    }
    simulation = createSimulation(CANNON, match, { ...(bodies ? { bodies } : {}), emit, random, humanOpponent: true,
        opponent(mallet, puck, difficulty, dt) {
            const b = mallet.body, target = targetFor(1) || { x: -b.position.x, z: -b.position.z };
            // Rotate to seat-local coordinates, run identical human motion, rotate back.
            const local = { target: { ...target }, body: { position: { x: -b.position.x, z: -b.position.z }, velocity: { set(x, y, z) { b.velocity.set(-x, y, -z); } } } };
            updatePlayer(local, new Set(), dt);
        },
    });
    match.start();
    function forfeit(seat) {
        if (winner !== null) return;
        winner = 1 - seat; reason = 'forfeit';
        Object.assign(match.state, { screen: 'result', phase: 'finished', remaining: 0 });
        emit({ type: 'match-end', winner: winner === 0 ? 'player' : 'cpu' });
    }
    return {
        simulation,
        input(id, value) {
            const seat = seats.indexOf(id), previous = inputs[seat];
            if (disposed || seat < 0 || winner !== null || disconnected.some(Boolean) || match.state.phase !== 'live'
                || value?.matchId !== matchId || !Number.isSafeInteger(value.seq) || value.seq <= previous.seq
                || value.seq > previous.seq + 10000 || !Number.isFinite(value.x) || !Number.isFinite(value.z)
                || tick - previous.tick < 2) return false;
            Object.assign(previous, { seq: value.seq, tick, target: clampTarget(value) });
            return true;
        },
        tick(dt = FIXED_DT) {
            if (disposed || winner !== null || disconnected.some(Boolean)) return;
            if (dt !== FIXED_DT) throw new Error('Authority requires the fixed 240 Hz step');
            tick++;
            match.tick(dt);
            const b = simulation.bodies.player.body;
            simulation.tick(dt, { target: targetFor(0) || { x: b.position.x, z: b.position.z }, dx: 0, dz: 0, keys: new Set() });
        },
        disconnect(id, now, immediate = false) {
            const seat = seats.indexOf(id);
            if (seat < 0 || winner !== null) return;
            if (immediate) forfeit(seat);
            else disconnected[seat] ||= now + RECONNECT_MS;
            for (const input of inputs) input.target = null;
        },
        reconnect(id, now) {
            const seat = seats.indexOf(id);
            if (seat < 0 || winner !== null || !disconnected[seat] || now >= disconnected[seat]) return false;
            disconnected[seat] = 0;
            return true;
        },
        expire(now) { disconnected.forEach((deadline, seat) => { if (deadline && now >= deadline) forfeit(seat); }); },
        snapshot() {
            const pack = b => ({ x: b.position.x, z: b.position.z, vx: b.velocity.x, vz: b.velocity.z });
            return { protocolVersion: PROTOCOL_VERSION, matchId, tick, seats: [...seats],
                phase: match.state.phase, remaining: match.state.remaining, scores: [match.state.playerScore, match.state.cpuScore],
                serving: match.state.servingPlayer ? 0 : 1, winner, reason, ack: inputs.map(i => i.seq),
                disconnected: disconnected.map(Boolean), puck: pack(simulation.bodies.puckBody),
                paddles: [simulation.bodies.player, simulation.bodies.cpu].map(m => pack(m.body)), events: [...events],
            };
        },
        dispose() { disposed = true; simulation.dispose(); },
    };
}
