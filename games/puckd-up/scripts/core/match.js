import { normalizeSettings } from '../settings.js';
// Owns screens, score and round timing. No DOM, browser timers, physics or audio.
// Consumers observe events; only these commands may transition match state.
export function createMatch({ config = {}, emit = () => {
} } = {}) {
    const settings = normalizeSettings(config);
    const state = { mode: 'cpu', screen: 'menu', phase: 'idle', playerScore: 0, cpuScore: 0, servingPlayer: true, remaining: 0 };
    function screen(value) {
        state.screen = value;
        emit({ type: 'screen', screen: value });
    }
    function faceoff(servingPlayer) {
        Object.assign(state, { phase: 'faceoff', servingPlayer, remaining: .65 });
        emit({ type: 'round-reset', servingPlayer });
    }
    return {
        state, config: settings,
        online() {
            if (state.screen === 'menu')
                screen('online');
        },
        setup() {
            if (state.screen === 'menu')
                screen('setup');
        },
        start() {
            if (state.mode === 'online') return;
            Object.assign(state, { playerScore: 0, cpuScore: 0 });
            screen('playing');
            emit({ type: 'match-start' });
            faceoff(true);
        },
        menu() {
            Object.assign(state, { mode: 'cpu', matchId: '', opponentName: '', winner: null, reason: '', disconnected: false, phase: 'idle', playerScore: 0, cpuScore: 0, remaining: 0 });
            screen('menu');
            emit({ type: 'match-reset' });
        },
        pause() {
            if (state.mode === 'online') return;
            if (state.screen === 'playing')
                screen('paused');
        },
        resume() {
            if (state.screen === 'paused')
                screen('playing');
        },
        score(playerScored) {
            if (state.mode === 'online') return false;
            if (state.screen !== 'playing' || state.phase !== 'live')
                return false;
            state[playerScored ? 'playerScore' : 'cpuScore']++;
            Object.assign(state, { phase: 'goal', remaining: 1.05, servingPlayer: !playerScored });
            emit({ type: 'goal', playerScored });
            if (state.playerScore >= settings.targetScore || state.cpuScore >= settings.targetScore) {
                state.phase = 'finished';
                state.remaining = 0;
                screen('result');
                emit({ type: 'match-end', winner: state.playerScore > state.cpuScore ? 'player' : 'cpu' });
            }
            return true;
        },
        tick(dt) {
            if (state.mode === 'online') return;
            if (state.screen !== 'playing' || !['faceoff', 'goal'].includes(state.phase))
                return;
            state.remaining = Math.max(0, state.remaining - dt);
            if (state.remaining > 1e-9)
                return;
            if (state.phase === 'goal')
                faceoff(state.servingPlayer);
            else {
                state.phase = 'live';
                emit({ type: 'serve', servingPlayer: state.servingPlayer });
            }
        },
        beginOnline({ matchId, opponentName }) {
            Object.assign(state, { mode: 'online', matchId, opponentName, playerScore: 0, cpuScore: 0, phase: 'faceoff', remaining: .65, winner: null, reason: '', disconnected: false });
            screen('playing');
            emit({ type: 'match-start' });
        },
        returnOnline() {
            Object.assign(state, { mode: 'cpu', matchId: '', phase: 'idle', remaining: 0, playerScore: 0, cpuScore: 0 });
            screen('online');
            emit({ type: 'match-reset' });
        },
        applyOnline(snapshot) {
            if (state.mode !== 'online' || snapshot.matchId !== state.matchId) return;
            Object.assign(state, { phase: snapshot.phase, remaining: snapshot.remaining, playerScore: snapshot.scores[0], cpuScore: snapshot.scores[1], servingPlayer: snapshot.servingPlayer,
                winner: snapshot.winner, reason: snapshot.reason, disconnected: snapshot.disconnected.some(Boolean) });
            const next = snapshot.phase === 'finished' ? 'result' : 'playing';
            if (state.screen !== next) screen(next);
        },
    };
}
