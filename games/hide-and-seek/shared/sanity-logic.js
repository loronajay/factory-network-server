(function attachHotelSanity(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HotelSanity = api;
})(typeof window !== 'undefined' ? window : globalThis, function createHotelSanityApi() {
  'use strict';

  // Sanity is the anti-camping clock. It fills whenever a player stays put in one place, and the
  // demon reads it: a full meter is an invitation. Leaving the room you are in resets it, and so do
  // steps taken in the hallway — the only way to keep it low is to keep moving through the hotel.
  const HALLWAY = 'hallway';

  // Three kinds of space, and the meter treats each differently: a room fills it and can be hunted,
  // the hallway fills it but is never entered by the demon, and a secret tunnel *drains* it. The
  // passages are the one genuine refuge in the hotel, and they cost you the walk to reach one.
  const ZONE_KINDS = Object.freeze({ ROOM: 'room', HALLWAY: 'hallway', TUNNEL: 'tunnel' });

  const SANITY_DEFAULTS = Object.freeze({
    fillSeconds: 42,
    // How far you have to walk in a corridor before the meter forgets you were ever standing still.
    hallwayStepDistance: 6,
    roomHalfSize: 4,
    // A floor apart is worth this many metres of corridor when the demon picks whom to visit. It is
    // deliberately large: the stairwell is the only way up, so a floor really is a long way.
    floorPenalty: 26,
    // Seconds a *full* meter takes to bleed away inside a secret tunnel. Deliberately much shorter
    // than fillSeconds — a passage should feel like relief — but not instant, so diving into one at
    // 99% still means sitting there a moment.
    tunnelDrainSeconds: 12,
  });

  function settings(config) {
    return config ? { ...SANITY_DEFAULTS, ...config } : SANITY_DEFAULTS;
  }

  function zoneKindOf(zone) {
    return zone.kind || ZONE_KINDS.ROOM;
  }

  // The kind a caller meant when it only told us a zone id: the hallway names itself, everything
  // else is a room until something says otherwise. A tunnel must always be explicit.
  function kindFromZoneId(kind, zoneId) {
    return kind || (zoneId === HALLWAY ? ZONE_KINDS.HALLWAY : ZONE_KINDS.ROOM);
  }

  // A room is an 8x8 box given by its centre (that is the shape `roomCenters` already holds); a
  // tunnel runs the length of the two rooms it links, so it carries explicit bounds instead.
  function zoneBounds(zone, half) {
    if (zoneKindOf(zone) === ZONE_KINDS.TUNNEL) return zone;
    return { minX: zone.x - half, maxX: zone.x + half, minZ: zone.z - half, maxZ: zone.z + half };
  }

  // Which space a point is standing in — a box test, not a raycast. Floor 0 is the stairwell or a
  // moving elevator and is always hallway. Tunnels are tested first: their floor rect shares a few
  // centimetres of solid wall with the room box next door, and the tunnel is the more specific space.
  function locateZone(zones, { x, z, floor }, config) {
    const half = settings(config).roomHalfSize;
    const hallway = { id: HALLWAY, kind: ZONE_KINDS.HALLWAY };
    if (!zones || !zones.length || !floor || floor < 1) return hallway;
    for (const pass of [ZONE_KINDS.TUNNEL, ZONE_KINDS.ROOM]) {
      for (const zone of zones) {
        const kind = zoneKindOf(zone);
        if (kind !== pass || zone.floor !== floor) continue;
        const bounds = zoneBounds(zone, half);
        if (x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ) return { id: zone.id, kind };
      }
    }
    return hallway;
  }

  function createSanityState() {
    return { zone: null, kind: ZONE_KINDS.HALLWAY, seconds: 0, value: 0, hallwayDistance: 0, full: false, reset: null };
  }

  function resetTo(zone, kind, reason) {
    return { zone, kind, seconds: 0, value: 0, hallwayDistance: 0, full: false, reset: reason };
  }

  function updateSanity(previous, { zone, kind, delta = 0, movedDistance = 0, config } = {}) {
    const cfg = settings(config);
    const zoneKind = kindFromZoneId(kind, zone);
    // A zone change wipes the meter and the tick that carried the player out of the room; the very
    // first tick of a session is not a change, though, so it keeps its own time. Stepping into a
    // secret tunnel is the one exception — the meter comes with you and drains, so a passage has to
    // be sat in rather than merely touched.
    const starting = previous.zone === null;
    const changed = !starting && zone !== previous.zone;
    if (changed && zoneKind !== ZONE_KINDS.TUNNEL) return resetTo(zone, zoneKind, 'zone');
    const carried = starting ? 0 : previous.seconds;
    let hallwayDistance = 0;
    if (zoneKind === ZONE_KINDS.HALLWAY) {
      hallwayDistance = (starting ? 0 : previous.hallwayDistance) + movedDistance;
      if (hallwayDistance >= cfg.hallwayStepDistance) return resetTo(zone, zoneKind, 'steps');
    }
    const drainPerSecond = cfg.tunnelDrainSeconds > 0 ? cfg.fillSeconds / cfg.tunnelDrainSeconds : Infinity;
    const seconds = zoneKind === ZONE_KINDS.TUNNEL
      ? Math.max(0, carried - delta * drainPerSecond)
      : Math.min(cfg.fillSeconds, carried + delta);
    return {
      zone,
      kind: zoneKind,
      seconds,
      hallwayDistance,
      value: cfg.fillSeconds > 0 ? Math.min(1, seconds / cfg.fillSeconds) : 1,
      // A tunnel can never read full, however long you sit in it.
      full: zoneKind !== ZONE_KINDS.TUNNEL && seconds >= cfg.fillSeconds,
      reset: starting ? 'start' : null,
    };
  }

  function createPlayerSanity(position = {}) {
    return { meter: createSanityState(), lastX: position.x || 0, lastZ: position.z || 0, candidate: null };
  }

  function updatePlayerSanity(previous, player, zones, delta, config) {
    const tracker = previous || createPlayerSanity(player);
    const zone = locateZone(zones, player, config);
    const movedDistance = Math.hypot(player.x - tracker.lastX, player.z - tracker.lastZ);
    const meter = updateSanity(tracker.meter, { zone: zone.id, kind: zone.kind, delta, movedDistance, config });
    return {
      meter,
      lastX: player.x,
      lastZ: player.z,
      candidate: { id: player.id, full: meter.full, zone: meter.zone, kind: meter.kind, x: player.x, z: player.z, floor: player.floor || 1 },
    };
  }

  function huntDistance(candidate, enemy, floorPenalty) {
    return Math.hypot(candidate.x - enemy.x, candidate.z - enemy.z)
      + Math.abs((candidate.floor || 1) - (enemy.floor || 1)) * floorPenalty;
  }

  // Whom the demon goes and visits. A full meter alone is not enough: it walks into *rooms*, so a
  // player idling in a corridor is spared, and when several are full it takes the nearest — which is
  // what "if the demon is closest to you" means once there is more than one hider.
  function selectHuntTarget(candidates, enemy = null, config) {
    const cfg = settings(config);
    const full = (candidates || []).filter((entry) => entry && entry.full && entry.zone && kindFromZoneId(entry.kind, entry.zone) === ZONE_KINDS.ROOM);
    if (!full.length) return null;
    if (!enemy) return full[0];
    let best = null;
    let bestDistance = Infinity;
    for (const candidate of full) {
      const distance = huntDistance(candidate, enemy, cfg.floorPenalty);
      if (distance < bestDistance) { best = candidate; bestDistance = distance; }
    }
    return best;
  }

  return { HALLWAY, SANITY_DEFAULTS, ZONE_KINDS, createPlayerSanity, createSanityState, huntDistance, locateZone, selectHuntTarget, updatePlayerSanity, updateSanity };
});
