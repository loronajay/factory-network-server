import test from 'node:test';
import assert from 'node:assert/strict';
import { createYamMatchState, applyYamShot, serializeYamMatch, requestYamRematch, applyYamDisconnect, applyYamReconnect } from './server/yam-bowling-match-engine.mjs';
import { yamBowlingLobbyGame } from './server/yam-bowling-lobby-game.mjs';

const lobby = () => ({ roomCode: 'THREE', seed: 123, members: new Set(['a', 'b']),
  settings: { bowlingStyle: '3d', matchType: 'quick', ranked: false, protocolVersion: 3 },
  yamProfiles: new Map(['a', 'b'].map(id => [id, { protocolVersion: 3 }])) });
const shot = { position: -.3, aim: .12, hook: .6, power: .7, release: 0, ballIndex: 0, expectedRollNumber: 0 };

test('3D is frozen into the match, reconnect snapshot and mutual rematch', () => {
  const room = lobby();
  let match = createYamMatchState(room, 1000);
  assert.equal(match.bowlingStyle, '3d');
  assert.equal(serializeYamMatch(match).match.bowlingStyle, '3d');
  match = applyYamReconnect(applyYamDisconnect(match, 'a', 2000), 'a', 2500);
  assert.equal(serializeYamMatch(match).bowlingStyle, '3d');
  match = { ...match, phase: 'complete', status: 'complete' };
  const rematch = requestYamRematch(requestYamRematch(match, 'a').match, 'b');
  assert.equal(rematch.started, true);
  assert.equal(rematch.match.bowlingStyle, '3d');
});

test('3D rooms require physics-capable clients while legacy 2D rooms remain supported', () => {
  const room = lobby();
  assert.equal(yamBowlingLobbyGame.canStart(room), true);
  room.yamProfiles.get('b').protocolVersion = 2;
  assert.equal(yamBowlingLobbyGame.canStart(room), false);
  room.settings.bowlingStyle = 'arcade';
  assert.equal(yamBowlingLobbyGame.canStart(room), true);
});

test('the server owns 3D pin falls and cannot be given a client-authored result', () => {
  const original = createYamMatchState(lobby(), 1000);
  const resolved = applyYamShot(original, 'a', { ...shot, knocked: 10, pinFalls: [{ id: 1, time: 0 }] });
  assert.equal(resolved.error, null);
  const roll = resolved.match.lastRoll;
  assert.ok(Array.isArray(roll.pinFalls));
  assert.equal(roll.pinFalls.length, roll.knocked);
  assert.ok(roll.duration > 0 && roll.duration < 30);
  assert.ok(roll.pinFalls.every(p => p.time > 0 && p.time <= roll.duration));
  assert.equal(new Set(roll.pinFalls.map(p => p.id)).size, roll.knocked);
  assert.equal(applyYamShot(resolved.match, resolved.match.players[resolved.match.activePlayer].id, shot).error.code, 'NOT_READY_FOR_SHOT');
  assert.deepEqual(applyYamShot(original, 'a', shot).match.lastRoll.pinFalls, roll.pinFalls);
  assert.equal(JSON.parse(JSON.stringify(serializeYamMatch(resolved.match))).lastRoll.pinFalls.length, roll.knocked);
  const serial = serializeYamMatch(resolved.match);
  serial.lastRoll.pinFalls[0].time = -1;
  assert.ok(roll.pinFalls[0].time > 0, 'wire snapshots must not alias the authoritative timeline');
});

test('3D simulation yields so other rooms and reconnect traffic remain responsive', async () => {
  const { simulate3dShotAsync } = await import('./shared/yam-bowling-3d.mjs');
  const original = createYamMatchState(lobby(), 1000);
  let heartbeat = false;
  setImmediate(() => { heartbeat = true; });
  const pending = simulate3dShotAsync(original.pins, shot);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(heartbeat, true);
  const resolved = await pending;
  assert.equal(resolved.knocked, resolved.pinFalls.length);
});

test('live 3D shots are asynchronous, reject duplicates and preserve a mid-shot disconnect', async () => {
  const room = lobby();
  yamBowlingLobbyGame.initMatch(room, 1000);
  const accepted = yamBowlingLobbyGame.handleMessage(room, 'a', 'yam_shot', JSON.stringify(shot));
  assert.equal(accepted.handled, true);
  assert.equal(room.yamMatch.rollNumber, 0, 'the handler returns before expensive physics');
  assert.ok(room.yamPendingShot?.promise);
  const duplicate = yamBowlingLobbyGame.handleMessage(room, 'a', 'yam_shot', JSON.stringify(shot));
  assert.equal(duplicate.error.code, 'NOT_READY_FOR_SHOT');
  yamBowlingLobbyGame.applyDisconnect(room, 'b', 1200);
  await room.yamPendingShot.promise;
  assert.equal(room.yamMatch.rollNumber, 1);
  assert.equal(room.yamMatch.phase, 'paused');
  assert.equal(room.yamMatch.players[1].connected, false);
  assert.equal(room.yamPendingShot, null);
});
