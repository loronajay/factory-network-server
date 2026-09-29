// Windrush Downs races — the race room (javascript-games planning-docs/FARM_RIDING_PLAN.md).
//
// A race is decided here, not in any browser. platform-api decides WHO rides
// and on WHAT (each horse's ride profile, as the API computed it from the
// stored farm) and signs that as the race ticket; it signs each rider a seat
// only they are handed. This room trusts nothing else: a join must carry a
// ticket that verifies, a rider's join a seat that verifies, and from then on
// a rider sends nothing but sequenced input bytes. The room runs the mirrored
// riding set (`../mirror`, copied byte for byte by javascript-games'
// tools/mirror-riding-sim.mjs) at 60 ticks a second from the ticket's start
// time, sends each rider a snapshot with the last input it took, and when every
// horse has finished (or run out of time) signs the finish order. Any rider
// hands that signed result to the API, which settles the stakes and bets.
//
//   downs_race_join  { raceId, ticket: { payload, signature }, playerId, seat? }
//   downs_race_input { raceId, inputs: [{ seq, input }] }
//   downs_race_leave
//
// Server events: downs_race_joined, downs_race_state, downs_race_result, error.
//
// The shared secret is FARM_RACE_SECRET, the same one platform-api signs with;
// without it every join is refused.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createRace, raceResult, stepRace, MAX_RIDERS } from "../mirror/downs-race.mjs";
import { unpackRideInput } from "../mirror/farm-ride.mjs";
import { findDownsCourse } from "../mirror/downs-course.mjs";

const GAME_ID = "farm-downs";
export const TICK_MS = 1000 / 60;
export const SNAPSHOT_MS = 50;
const MAX_TICKS_PER_ADVANCE = 12;
const MAX_QUEUED_INPUTS = 8;
const MAX_INPUT_BATCH = 12;
/** A finished race stays this long so a late rider still receives its result. */
const LINGER_MS = 60_000;
/** Joins are accepted from this long before the start. */
const EARLY_JOIN_MS = 30_000;
const NEUTRAL = unpackRideInput(0);

// ---------------------------------------------------------------- signatures (the API's services/farm-race-policy.mts)

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function signRacePayload(secret, kind, payload) {
  return createHmac("sha256", secret).update(`${kind}:${canonicalJson(payload)}`).digest("hex");
}

export function verifyRacePayload(secret, kind, payload, signature) {
  if (!secret || typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(signRacePayload(secret, kind, payload), "hex");
  const given = Buffer.from(signature, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------- the room

export function createDownsRaceBridge({ sendToClient, now = () => Date.now(), secret = () => process.env.FARM_RACE_SECRET ?? "", setRepeating, clearRepeating } = {}) {
  const repeat = setRepeating ?? ((fn, ms) => { const handle = setInterval(fn, ms); handle.unref?.(); return handle; });
  const stop = clearRepeating ?? ((handle) => clearInterval(handle));
  /** raceId -> race */
  const races = new Map();
  /** clientId -> raceId */
  const clientRaces = new Map();

  function emit(clientId, payload) {
    sendToClient(clientId, payload);
  }

  function refuse(clientId, code, message) {
    emit(clientId, { event: "error", code, message });
  }

  function snapshotFor(race, clientId) {
    const client = race.clients.get(clientId);
    return {
      event: "downs_race_state",
      raceId: race.id,
      tick: race.sim.tick,
      phase: race.sim.phase,
      riders: race.sim.riders.map((rider) => ({ playerId: rider.playerId, ride: rider.ride, next: rider.next, faults: rider.faults, finishTick: rider.finishTick, dnf: rider.dnf })),
      acked: client?.playerId ? race.queues.get(client.playerId)?.acked ?? 0 : 0,
    };
  }

  function broadcast(race, payloadFor) {
    for (const clientId of race.clients.keys()) emit(clientId, payloadFor(clientId));
  }

  function finish(race) {
    const result = { raceId: race.id, ...raceResult(race.sim) };
    const plain = { raceId: result.raceId, order: [...result.order], finishTicks: { ...result.finishTicks }, dnf: [...result.dnf] };
    race.result = { result: plain, signature: signRacePayload(secret(), "result", plain) };
    race.finishedAt = now();
    broadcast(race, () => ({ event: "downs_race_result", raceId: race.id, ...race.result }));
  }

  function advance(race) {
    const at = now();
    if (race.result) {
      if (at - race.finishedAt > LINGER_MS) retire(race);
      return;
    }
    if (at > race.deadlineAt) {
      // Out of time before the field was home: whatever the sim holds is the result.
      finish(race);
      return;
    }
    if (at < race.startsAt) return;
    const owed = Math.floor((at - race.lastAdvanceAt) / TICK_MS);
    const ticks = Math.min(Math.max(0, owed), MAX_TICKS_PER_ADVANCE);
    if (owed > ticks) race.lastAdvanceAt = at;
    else race.lastAdvanceAt += ticks * TICK_MS;
    for (let index = 0; index < ticks && race.sim.phase !== "finished"; index += 1) {
      const inputs = new Map();
      for (const [playerId, queue] of race.queues) {
        const next = queue.items.shift();
        if (next) {
          queue.last = unpackRideInput(next.input);
          queue.acked = next.seq;
        }
        inputs.set(playerId, queue.last);
      }
      race.sim = stepRace(race.sim, inputs, race.profiles);
    }
    broadcast(race, (clientId) => snapshotFor(race, clientId));
    if (race.sim.phase === "finished") finish(race);
  }

  function retire(race) {
    if (race.timer) stop(race.timer);
    for (const clientId of race.clients.keys()) clientRaces.delete(clientId);
    races.delete(race.id);
  }

  function openRace(payload) {
    const course = findDownsCourse(payload.courseId);
    if (!course) return null;
    const entries = (Array.isArray(payload.entries) ? payload.entries : []).slice(0, MAX_RIDERS);
    const race = {
      id: payload.raceId,
      courseId: payload.courseId,
      startsAt: Number(payload.startsAt),
      deadlineAt: Number(payload.deadlineAt),
      entries,
      profiles: new Map(entries.map((entry) => [entry.playerId, entry.profile])),
      queues: new Map(entries.map((entry) => [entry.playerId, { items: [], last: NEUTRAL, lastSeq: 0, acked: 0 }])),
      sim: createRace(payload.courseId, entries),
      clients: new Map(),
      lastAdvanceAt: Number(payload.startsAt),
      result: null,
      finishedAt: 0,
      timer: null,
    };
    race.timer = repeat(() => {
      try {
        advance(race);
      } catch (error) {
        console.error(`[farm-downs] race ${race.id} tick failed`, error);
        retire(race);
      }
    }, SNAPSHOT_MS);
    races.set(race.id, race);
    return race;
  }

  function join(clientId, data) {
    const key = secret();
    if (!key) return refuse(clientId, "RACES_UNAVAILABLE", "Races are not set up on this server");
    const ticket = data?.ticket;
    const payload = ticket?.payload;
    if (!payload || typeof payload.raceId !== "string" || payload.raceId !== data.raceId || !verifyRacePayload(key, "ticket", payload, ticket.signature)) {
      return refuse(clientId, "BAD_TICKET", "That race ticket does not verify");
    }
    const at = now();
    if (at > Number(payload.deadlineAt) || at < Number(payload.startsAt) - EARLY_JOIN_MS) return refuse(clientId, "NOT_NOW", "That race is not running now");
    let playerId = null;
    if (data.seat !== undefined) {
      const claimed = typeof data.playerId === "string" ? data.playerId : "";
      if (!verifyRacePayload(key, "seat", { raceId: payload.raceId, playerId: claimed }, data.seat)) return refuse(clientId, "BAD_SEAT", "That seat does not verify");
      if (!payload.entries.some((entry) => entry.playerId === claimed)) return refuse(clientId, "BAD_SEAT", "Not a rider in this race");
      playerId = claimed;
    }
    const previous = clientRaces.get(clientId);
    if (previous && previous !== payload.raceId) leave(clientId);
    const race = races.get(payload.raceId) ?? openRace(payload);
    if (!race) return refuse(clientId, "BAD_TICKET", "Unknown course");
    // A rider on a new socket replaces the old one.
    if (playerId) for (const [other, client] of race.clients) if (other !== clientId && client.playerId === playerId) { race.clients.delete(other); clientRaces.delete(other); }
    race.clients.set(clientId, { playerId });
    clientRaces.set(clientId, race.id);
    emit(clientId, { event: "downs_race_joined", raceId: race.id, role: playerId ? "rider" : "watcher", now: at, startsAt: race.startsAt });
    if (race.result) emit(clientId, { event: "downs_race_result", raceId: race.id, ...race.result });
  }

  function input(clientId, data) {
    const race = races.get(clientRaces.get(clientId));
    const client = race?.clients.get(clientId);
    if (!race || !client?.playerId) return refuse(clientId, "NOT_RIDING", "You are not riding in a race");
    const queue = race.queues.get(client.playerId);
    if (!queue) return;
    const batch = Array.isArray(data?.inputs) ? data.inputs.slice(-MAX_INPUT_BATCH) : [];
    for (const entry of batch) {
      const seq = Math.floor(Number(entry?.seq));
      const byte = Math.floor(Number(entry?.input));
      if (!Number.isFinite(seq) || seq <= queue.lastSeq || seq > queue.lastSeq + 100_000 || !(byte >= 0 && byte < 64)) continue;
      queue.lastSeq = seq;
      queue.items.push({ seq, input: byte });
    }
    if (queue.items.length > MAX_QUEUED_INPUTS) queue.items.splice(0, queue.items.length - MAX_QUEUED_INPUTS / 2);
  }

  function leave(clientId) {
    const race = races.get(clientRaces.get(clientId));
    clientRaces.delete(clientId);
    race?.clients.delete(clientId);
  }

  function handleClientMessage(clientId, data) {
    try {
      switch (String(data?.type || "")) {
        case "downs_race_join": join(clientId, data); break;
        case "downs_race_input": input(clientId, data); break;
        case "downs_race_leave": leave(clientId); break;
        default: refuse(clientId, "UNKNOWN_TYPE", "Unknown message type");
      }
    } catch (error) {
      refuse(clientId, "INTERNAL", "Something went wrong while handling that message");
      console.error(`[farm-downs] ${String(data?.type || "message")} from ${clientId}:`, error);
    }
  }

  return Object.freeze({
    gameId: GAME_ID,
    handleClientMessage,
    handleClientDisconnect: (clientId) => leave(clientId),
    ownsClient: (clientId) => clientRaces.has(clientId),
    hasRoomCode: () => false,
    raceCount: () => races.size,
    /** For tests: run a race's clock by hand. */
    advanceAll: () => { for (const race of [...races.values()]) advance(race); },
    race: (raceId) => races.get(raceId) ?? null,
  });
}
