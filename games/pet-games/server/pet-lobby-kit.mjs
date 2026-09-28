// What both Pet Games lobby games share: how a person's pet gets into a lobby,
// how the chairs are filled (people first, then CPU guests from the shared
// rival pool), how inputs are queued, and how one interval ticks a match.
//
// Nothing here decides a race or a brawl — the mirrored sims under ../mirror do
// that — and nothing here trusts a client with more than its own keys.
import { broadcastToLobby, sendLobbyUpdated } from "../../../src/lobby-bus.mjs";
import { pickRivals, rivalAsPet, sanitizePet } from "../mirror/games/pet-games/shared/sim/rivals.js";
import { cpuLevelFromIndex } from "../mirror/games/pet-games/shared/sim/levels.js";

export const PET_GAMES_RECONNECT_GRACE_MS = 20_000;
export const PET_GAMES_TICK_MS = 1000 / 60;
/** Snapshots go out this often; the sim runs at 60 underneath and clients predict their own pet. */
export const PET_GAMES_SNAPSHOT_MS = 50;
/** A stalled process must not replay seconds of match in one frame. */
const MAX_TICKS_PER_ADVANCE = 12;
/** A client that runs fast queues inputs; beyond this many the oldest are dropped. */
const MAX_QUEUED_INPUTS = 8;
/** The most inputs one message may carry. */
const MAX_INPUT_BATCH = 12;

export function parse(value) {
  if (value && typeof value === "object") return value;
  try { return typeof value === "string" ? JSON.parse(value) : null; } catch { return null; }
}

function clean(value, max, fallback = "") {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, max);
}

// ---------------------------------------------------------------- the pet a person brings

/**
 * A person names the pet they are bringing. It is sanitized to the farm's shape
 * (species, coat, stats in range) and shown on the lobby roster. Stats are the
 * client's claim: they move a race by a few percent at most, and the farm that
 * owns them lives in platform-api, which this server never reads.
 */
export function rememberPet(lobby, clientId, raw) {
  const pet = sanitizePet(raw);
  if (!(lobby.petProfiles instanceof Map)) lobby.petProfiles = new Map();
  lobby.petProfiles.set(clientId, pet);
  if (!(lobby.publicPlayerFields instanceof Map)) lobby.publicPlayerFields = new Map();
  lobby.publicPlayerFields.set(clientId, {
    pet: { speciesId: pet.speciesId, name: pet.name, paletteId: pet.paletteId, stats: { ...pet.stats } },
  });
  sendLobbyUpdated(lobby);
  return pet;
}

const LOANER = Object.freeze({ instanceId: "borrowed-corgi", speciesId: "pet.corgi", name: "Borrowed Biscuit", paletteId: "standard", stats: { speed: 50, strength: 50, size: 1 } });

/** The people in the lobby, in seat order, each with the pet they brought (or a loaner). */
export function humanSeats(lobby) {
  return [...(lobby?.members || [])].map((clientId, index) => {
    const profile = lobby?.memberProfiles?.get(clientId) || {};
    return {
      clientId,
      seatId: `seat-${index + 1}`,
      name: clean(profile.displayName, 18, `Player ${index + 1}`),
      accountPlayerId: clean(profile.playerId, 64),
      pet: lobby?.petProfiles?.get(clientId) ?? { ...LOANER, stats: { ...LOANER.stats } },
    };
  });
}

/** CPU guests for the chairs people left empty: never more than the host asked for. */
export function cpuSeats(lobby, humans, maxSeats) {
  const wanted = Math.max(0, Math.floor(Number(lobby?.settings?.cpuCount) || 0));
  const count = Math.max(0, Math.min(wanted, maxSeats - humans));
  const level = cpuLevelFromIndex(lobby?.settings?.cpuLevel ?? 1);
  return pickRivals({ seed: `${lobby?.seed ?? "seed"}:cpu`, count, level }).map((rival) => ({
    seatId: rival.id,
    level,
    pet: rivalAsPet(rival),
  }));
}

// ---------------------------------------------------------------- inputs

/**
 * One queue per person. A client sends every tick's input with a rising
 * sequence number, batched; the tick takes exactly one per person per step
 * (holding the last when the queue runs dry), and the snapshot acknowledges
 * the last one taken — which is what lets the client replay only what the
 * server has not yet seen.
 */
export function createInputQueue(read) {
  return { read, queue: [], last: read({}), lastSeq: 0, acked: 0 };
}

export function pushInputs(queue, value) {
  const batch = Array.isArray(value?.inputs) ? value.inputs.slice(-MAX_INPUT_BATCH) : [value];
  for (const entry of batch) {
    const seq = Math.floor(Number(entry?.seq));
    if (!Number.isFinite(seq) || seq <= queue.lastSeq || seq > queue.lastSeq + 100_000) continue;
    queue.lastSeq = seq;
    queue.queue.push({ seq, input: queue.read(entry?.input ?? entry) });
  }
  if (queue.queue.length > MAX_QUEUED_INPUTS) queue.queue.splice(0, queue.queue.length - MAX_QUEUED_INPUTS / 2);
}

export function takeInput(queue) {
  const next = queue.queue.shift();
  if (next) {
    queue.last = next.input;
    queue.acked = next.seq;
  }
  return queue.last;
}

export function clearInputs(queue) {
  queue.queue.length = 0;
  queue.last = queue.read({});
}

// ---------------------------------------------------------------- the clock

/** How many fixed ticks a match is owed since it last advanced (capped), moving its clock on. */
export function owedTicks(match, now) {
  if (now < match.startAt) return 0;
  if (match.phase === "scheduled") {
    match.phase = "active";
    match.lastAdvanceAt = match.startAt;
  }
  const owed = Math.floor((now - match.lastAdvanceAt) / PET_GAMES_TICK_MS);
  const ticks = Math.min(Math.max(0, owed), MAX_TICKS_PER_ADVANCE);
  // A stall longer than the cap gives the debt up rather than fast-forwarding the match.
  if (owed > ticks) match.lastAdvanceAt = now;
  else match.lastAdvanceAt += ticks * PET_GAMES_TICK_MS;
  return ticks;
}

/**
 * One interval per match. `advance(now)` moves the match and says whether it
 * ended; `serialize()` is what goes out. When the match ends the lobby reopens,
 * so the same room can race again without anyone leaving.
 */
export function startTicking(lobby, key, { advance, serialize, messageType, endedMessageType, label }) {
  stopTicking(lobby, key);
  lobby[key] = setInterval(() => {
    // Anything escaping here would take down every match on the server, not just this one.
    try {
      const ended = advance(Date.now());
      broadcastToLobby(lobby.roomCode, {
        event: "message",
        scope: "lobby",
        roomCode: lobby.roomCode,
        messageType: ended ? endedMessageType : messageType,
        value: JSON.stringify(serialize()),
      });
      if (ended) {
        stopTicking(lobby, key);
        reopenLobby(lobby);
      }
    } catch (error) {
      stopTicking(lobby, key);
      console.error(`[${label}] tick failed`, error);
    }
  }, PET_GAMES_SNAPSHOT_MS);
  lobby[key].unref?.();
}

export function stopTicking(lobby, key) {
  if (lobby?.[key]) clearInterval(lobby[key]);
  if (lobby) lobby[key] = null;
}

/** A finished match hands the room back: same code, same people, ready for the host to start again. */
export function reopenLobby(lobby) {
  lobby.status = "open";
  lobby.startAt = null;
  sendLobbyUpdated(lobby);
}

export function broadcastState(lobby, messageType, state) {
  broadcastToLobby(lobby.roomCode, {
    event: "message",
    scope: "lobby",
    roomCode: lobby.roomCode,
    messageType,
    value: JSON.stringify(state),
  });
}
