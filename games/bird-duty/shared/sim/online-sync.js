import { NPC_DEFINITIONS } from "./npcs.js";

// The host owns every gameplay sound in an online match. Guest clients only ever
// see snapshots, so the host records what it played and ships the list along with
// the snapshot instead of letting the guest infer sounds from state deltas.
export const MAX_ONLINE_SOUND_EVENTS = 16;

export function getNpcSoundKey(type) {
  return NPC_DEFINITIONS[type]?.sound || null;
}

export function createOnlineSoundQueue() {
  return [];
}

export function queueOnlineSound(queue = [], name) {
  if (typeof name !== "string" || !name) return queue;
  if (queue.length >= MAX_ONLINE_SOUND_EVENTS) return queue;
  return [...queue, name];
}

export function queueOnlineNpcHitSounds(queue = [], hitTypes = []) {
  return hitTypes.reduce((next, type) => queueOnlineSound(next, getNpcSoundKey(type)), queue);
}

export function readOnlineSoundEvents(snapshot) {
  const events = snapshot?.sounds;
  if (!Array.isArray(events)) return [];
  return events
    .filter((name) => typeof name === "string" && name)
    .slice(0, MAX_ONLINE_SOUND_EVENTS);
}

export function playOnlineSoundEvents(sounds, snapshot) {
  const events = readOnlineSoundEvents(snapshot);
  for (const name of events) sounds?.play?.(name);
  return events;
}
