// This version describes physics/input semantics, not the generic socket API.
export const PROTOCOL_VERSION = 3;
export const SNAPSHOT_HZ = 30;
export const INPUT_HZ = 60;
export const RECONNECT_MS = 10000;
export const isPlayerColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value);
export const clampTarget = ({ x, z }) => ({ x: Math.max(-4.2, Math.min(4.2, x)), z: Math.max(.8, Math.min(7.15, z)) });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const body = value => value && ['x', 'z', 'vx', 'vz'].every(key => finite(value[key]) && Math.abs(value[key]) < 100);
export function validSnapshot(s) {
    return !!s && s.protocolVersion === PROTOCOL_VERSION && typeof s.matchId === 'string' && s.matchId.length > 0
        && integer(s.tick) && ['faceoff', 'live', 'goal', 'finished'].includes(s.phase)
        && Array.isArray(s.seats) && s.seats.length === 2 && s.seats.every(id => typeof id === 'string') && s.seats[0] !== s.seats[1]
        && Array.isArray(s.colors) && s.colors.length === 2 && s.colors.every(isPlayerColor)
        && Array.isArray(s.scores) && s.scores.length === 2 && s.scores.every(n => integer(n) && n <= 7)
        && Array.isArray(s.ack) && s.ack.length === 2 && s.ack.every(integer)
        && Array.isArray(s.paddles) && s.paddles.length === 2 && s.paddles.every(body) && body(s.puck)
        && [0, 1].includes(s.serving) && [null, 0, 1].includes(s.winner)
        && finite(s.remaining) && s.remaining >= 0 && s.remaining <= 2
        && Array.isArray(s.disconnected) && s.disconnected.length === 2 && s.disconnected.every(v => typeof v === 'boolean');
}
export function toSeatSnapshot(snapshot, seat) {
    const sign = seat === 1 ? -1 : 1;
    const rotate = b => ({ x: b.x * sign, z: b.z * sign, vx: b.vx * sign, vz: b.vz * sign });
    return { ...snapshot, puck: rotate(snapshot.puck), colors: [snapshot.colors[seat], snapshot.colors[1 - seat]],
        paddles: [snapshot.paddles[seat], snapshot.paddles[1 - seat]].map(rotate),
        scores: [snapshot.scores[seat], snapshot.scores[1 - seat]],
        servingPlayer: snapshot.serving === seat,
        winner: snapshot.winner === null ? null : snapshot.winner === seat ? 0 : 1,
    };
}
