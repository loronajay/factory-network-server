import { applyYamShot, validateYamShotRequest } from './yam-bowling-match-engine.mjs';
import { simulate3dShotAsync } from '../shared/yam-bowling-3d.mjs';

// One in-flight roll per room. Presence and reactions may change while physics
// yields; score against the latest revision, never overwrite it with old state.
export function queueYam3dShot(lobby, clientId, rawShot, { onSettled, onError }) {
  if (lobby.yamPendingShot) return { handled: true, error: { code: 'NOT_READY_FOR_SHOT', message: 'The current roll is still being resolved.' } };
  const original = lobby.yamMatch;
  const validation = validateYamShotRequest(original, clientId, rawShot);
  if (validation.error) return { handled: true, error: validation.error };
  const token = {};
  lobby.yamPendingShot = token;
  token.promise = simulate3dShotAsync(original.pins, validation.shot).then(resolved => {
    const current = lobby.yamMatch;
    if (lobby.yamPendingShot !== token || current?.sessionId !== original.sessionId
      || current.rollNumber !== original.rollNumber || current.phase === 'complete') return;
    const paused = current.phase === 'paused';
    const applied = applyYamShot(paused ? { ...current, phase: 'playing' } : current, clientId, rawShot, Date.now(), resolved);
    if (applied.error) return;
    if (paused && applied.match.phase !== 'complete') {
      applied.match.pausedPhase = applied.match.phase;
      applied.match.phase = 'paused';
    }
    lobby.yamMatch = applied.match;
    lobby.yamPendingShot = null;
    onSettled();
  }).catch(error => {
    if (lobby.yamPendingShot === token) onError(error);
  }).finally(() => {
    if (lobby.yamPendingShot === token) lobby.yamPendingShot = null;
  });
  return { handled: true };
}
