// Arcade Room presence — the players standing in one arcade at the same time.
//
// Not a match. There is no start, no end, no winner and nothing to adjudicate:
// a presence room is the set of clients currently walking one player's arcade
// (`/room/?id=<ownerPlayerId>` in the cabinet, keyed here by that owner id),
// and the server's only jobs are the roster and the relay. Each member
// publishes its own pose — where it stands, which way it faces, whether it is
// moving, and what it is doing (walking, or playing a named cabinet) — and the
// bridge fans that out to everyone else in the same arcade. A client's pose is
// its own business: nobody can be hurt, blocked or scored by it, so it is
// relayed as sent (sanitized to bounded numbers) rather than simulated.
//
// It is a self-owning bridge rather than a lobby because a lobby has seats,
// readiness and a start, and every one of those is wrong for a room people
// wander in and out of. The whole protocol is five client frames:
//
//   arcade_room_join  { roomId, sessionId, identity: { playerId, displayName, avatarId }, pose }
//   arcade_room_pose  { x, z, yaw, moving, activity }
//   arcade_room_emote { emote }
//   arcade_room_chat  { text }
//   arcade_room_leave
//
// and six server events: `arcade_room_joined` (to the joiner, with the whole
// roster), `arcade_room_member_joined`, `arcade_room_member_left`,
// `arcade_room_pose`, `arcade_room_emote` and `arcade_room_chat` (to everyone
// else in the arcade).
//
// Chat is a relay like everything else: a line goes out to the rest of the
// arcade with the sender's name as the roster knows it, never as the frame
// claims it. It is the one frame a person can flood on purpose, so it carries
// two limits a pose does not — a minimum gap between lines and a budget per
// window — and a line over either is refused with `TOO_FAST` rather than
// silently dropped, so the sender's own box can say so.
// Disconnecting is a leave. A join from a client already standing in an arcade
// moves it.
//
// Two things keep the roster honest when a socket dies without saying so (a
// phone sleeping, a Wi-Fi drop, a proxy giving up): a join whose player AND
// session are already standing in the arcade on another socket is a reconnect,
// and the old member is retired on the spot rather than left as a clone; and a
// member that has not been heard from in `STALE_MEMBER_MS` is swept out by the
// heartbeat. The client keeps alive every couple of seconds, so a sweep only
// ever catches a dead socket or a tab asleep for a long while — and that client
// rejoins by itself on the `NOT_IN_ROOM` its next pose earns.

const GAME_ID = "arcade-room";

export const MAX_MEMBERS_PER_ROOM = 12;
/** Room ids are player ids on the Factory; anything longer is not one. */
export const MAX_ROOM_ID_LENGTH = 128;
export const MAX_DISPLAY_NAME_LENGTH = 24;
export const MAX_ACTIVITY_LENGTH = 40;
export const MAX_AVATAR_ID_LENGTH = 48;
/** Poses arriving faster than this from one client are dropped, not relayed. */
export const MIN_POSE_INTERVAL_MS = 40;
/** A member silent for this long is gone, whatever its socket says; the client keeps alive every ~2 s. */
export const STALE_MEMBER_MS = 20_000;
export const MAX_SESSION_ID_LENGTH = 64;
export const MAX_CHAT_LENGTH = 200;
/** Two lines closer together than this from one member: the second is refused. */
export const MIN_CHAT_INTERVAL_MS = 400;
/** ...and no more than this many lines per member in any rolling window. */
export const MAX_CHATS_PER_WINDOW = 8;
export const CHAT_WINDOW_MS = 10_000;
/** Well outside any room the cabinet can build; keeps NaN and absurd values off the wire. */
const POSE_LIMIT = 100;
const EMOTES = new Set(["wave", "cheer"]);

function cleanText(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function sanitizeRoomId(value) {
  const id = cleanText(value, MAX_ROOM_ID_LENGTH + 1);
  return id.length > 0 && id.length <= MAX_ROOM_ID_LENGTH ? id : "";
}

export function sanitizePresenceIdentity(identity) {
  const source = identity && typeof identity === "object" ? identity : {};
  return {
    playerId: cleanText(source.playerId, MAX_ROOM_ID_LENGTH),
    displayName: cleanText(source.displayName, MAX_DISPLAY_NAME_LENGTH) || "Player",
    avatarId: cleanText(source.avatarId, MAX_AVATAR_ID_LENGTH),
  };
}

export function sanitizePose(pose, previous = null) {
  const source = pose && typeof pose === "object" ? pose : {};
  return {
    x: clamp(finite(source.x, previous?.x ?? 0), -POSE_LIMIT, POSE_LIMIT),
    z: clamp(finite(source.z, previous?.z ?? 0), -POSE_LIMIT, POSE_LIMIT),
    yaw: clamp(finite(source.yaw, previous?.yaw ?? 0), -1000, 1000),
    moving: source.moving === true,
    activity: cleanText(source.activity, MAX_ACTIVITY_LENGTH),
  };
}

export function sanitizeSessionId(value) {
  return cleanText(value, MAX_SESSION_ID_LENGTH);
}

export function sanitizeChatText(value) {
  return cleanText(value, MAX_CHAT_LENGTH);
}

export function sanitizeEmote(value) {
  const emote = cleanText(value, 16);
  return EMOTES.has(emote) ? emote : "";
}

export function createArcadeRoomPresenceBridge({ sendToClient, now = () => Date.now() } = {}) {
  /** roomId -> Map<clientId, member> */
  const rooms = new Map();
  /** clientId -> roomId */
  const clientRooms = new Map();

  function emit(clientId, payload) {
    sendToClient(clientId, payload);
  }

  function emitToOthers(roomId, exceptClientId, payload) {
    const members = rooms.get(roomId);
    if (!members) return;
    for (const clientId of members.keys()) {
      if (clientId !== exceptClientId) emit(clientId, payload);
    }
  }

  function publicMember(member) {
    return {
      clientId: member.clientId,
      playerId: member.playerId,
      displayName: member.displayName,
      avatarId: member.avatarId,
      pose: { ...member.pose },
    };
  }

  function leave(clientId, reason = "left") {
    const roomId = clientRooms.get(clientId);
    if (!roomId) return false;
    clientRooms.delete(clientId);
    const members = rooms.get(roomId);
    if (!members) return false;
    members.delete(clientId);
    if (members.size === 0) rooms.delete(roomId);
    else emitToOthers(roomId, clientId, { event: "arcade_room_member_left", roomId, clientId, reason });
    return true;
  }

  function join(clientId, data) {
    const roomId = sanitizeRoomId(data.roomId);
    if (!roomId) {
      emit(clientId, { event: "error", code: "BAD_MESSAGE", message: "arcade_room_join needs a roomId" });
      return;
    }
    // Moving between arcades is a leave and a join; the old room hears the leave.
    if (clientRooms.get(clientId) !== roomId) leave(clientId, "moved");
    let members = rooms.get(roomId);
    if (!members) {
      members = new Map();
      rooms.set(roomId, members);
    }
    if (!members.has(clientId) && members.size >= MAX_MEMBERS_PER_ROOM) {
      emit(clientId, { event: "error", code: "ROOM_FULL", message: "That arcade is full right now" });
      return;
    }
    const identity = sanitizePresenceIdentity(data.identity);
    const sessionId = sanitizeSessionId(data.sessionId);
    // The same person on the same page load arriving on a new socket is a reconnect: the old
    // socket is dead or dying, and its member would otherwise stand there as a clone until
    // the transport noticed. Two tabs are two sessions and both may stay.
    if (sessionId && identity.playerId) {
      for (const other of [...members.values()]) {
        if (other.clientId !== clientId && other.playerId === identity.playerId && other.sessionId === sessionId) {
          leave(other.clientId, "replaced");
        }
      }
    }
    const member = {
      clientId,
      ...identity,
      sessionId,
      pose: sanitizePose(data.pose),
      lastPoseAt: 0,
      lastHeardAt: now(),
      /** When this member's recent lines went out; the rate limit reads it. */
      chatAts: [],
    };
    const rejoining = members.has(clientId);
    members.set(clientId, member);
    clientRooms.set(clientId, roomId);
    emit(clientId, {
      event: "arcade_room_joined",
      roomId,
      clientId,
      members: [...members.values()].filter((other) => other.clientId !== clientId).map(publicMember),
    });
    // A rejoin in place (same room, new identity) reads as a fresh arrival to the others,
    // which is the simplest way to hand them the new name and body.
    emitToOthers(roomId, clientId, { event: "arcade_room_member_joined", roomId, member: publicMember(member), rejoined: rejoining });
  }

  function pose(clientId, data) {
    const roomId = clientRooms.get(clientId);
    const member = rooms.get(roomId)?.get(clientId);
    if (!member) {
      emit(clientId, { event: "error", code: "NOT_IN_ROOM", message: "You are not in an arcade" });
      return;
    }
    const at = now();
    member.lastHeardAt = at;
    if (at - member.lastPoseAt < MIN_POSE_INTERVAL_MS) return;
    member.lastPoseAt = at;
    member.pose = sanitizePose(data, member.pose);
    emitToOthers(roomId, clientId, { event: "arcade_room_pose", roomId, clientId, ...member.pose });
  }

  function emote(clientId, data) {
    const roomId = clientRooms.get(clientId);
    const member = rooms.get(roomId)?.get(clientId);
    if (!member) {
      emit(clientId, { event: "error", code: "NOT_IN_ROOM", message: "You are not in an arcade" });
      return;
    }
    member.lastHeardAt = now();
    const name = sanitizeEmote(data.emote);
    if (!name) {
      emit(clientId, { event: "error", code: "BAD_MESSAGE", message: "Unknown emote" });
      return;
    }
    emitToOthers(roomId, clientId, { event: "arcade_room_emote", roomId, clientId, emote: name });
  }

  function chat(clientId, data) {
    const roomId = clientRooms.get(clientId);
    const member = rooms.get(roomId)?.get(clientId);
    if (!member) {
      emit(clientId, { event: "error", code: "NOT_IN_ROOM", message: "You are not in an arcade" });
      return;
    }
    const at = now();
    member.lastHeardAt = at;
    const text = sanitizeChatText(data.text);
    if (!text) {
      emit(clientId, { event: "error", code: "BAD_MESSAGE", message: "Nothing to say" });
      return;
    }
    member.chatAts = member.chatAts.filter((sentAt) => at - sentAt < CHAT_WINDOW_MS);
    const last = member.chatAts[member.chatAts.length - 1] ?? -Infinity;
    if (at - last < MIN_CHAT_INTERVAL_MS || member.chatAts.length >= MAX_CHATS_PER_WINDOW) {
      emit(clientId, { event: "error", code: "TOO_FAST", message: "Slow down a little" });
      return;
    }
    member.chatAts.push(at);
    emitToOthers(roomId, clientId, {
      event: "arcade_room_chat",
      roomId,
      clientId,
      displayName: member.displayName,
      text,
      at,
    });
  }

  function handleClientMessage(clientId, data) {
    try {
      switch (String(data?.type || "")) {
        case "arcade_room_join": join(clientId, data); break;
        case "arcade_room_pose": pose(clientId, data); break;
        case "arcade_room_emote": emote(clientId, data); break;
        case "arcade_room_chat": chat(clientId, data); break;
        case "arcade_room_leave": leave(clientId, "left"); break;
        default:
          emit(clientId, { event: "error", code: "UNKNOWN_TYPE", message: "Unknown message type" });
      }
    } catch (error) {
      emit(clientId, { event: "error", code: "INTERNAL", message: "Something went wrong while handling that message" });
      console.error(`[arcade-room] ${String(data?.type || "message")} from ${clientId}:`, error);
    }
  }

  function handleClientDisconnect(clientId, reason) {
    try {
      leave(clientId, reason || "disconnected");
    } catch (error) {
      console.error(`[arcade-room] disconnect for ${clientId}:`, error);
    }
  }

  // Presence has no simulation; the tick only sweeps out members nobody has heard from.
  function tickActiveRooms() {
    const cutoff = now() - STALE_MEMBER_MS;
    for (const members of [...rooms.values()]) {
      for (const member of [...members.values()]) {
        if (member.lastHeardAt < cutoff) leave(member.clientId, "timeout");
      }
    }
  }

  function ownsClient(clientId) {
    return clientRooms.has(clientId);
  }

  // Presence rooms are keyed by player id, never by a five-letter room code, so no
  // generic room or lobby code can collide with one.
  function hasRoomCode() {
    return false;
  }

  function roomMembers(roomId) {
    return [...(rooms.get(roomId)?.values() ?? [])].map(publicMember);
  }

  return Object.freeze({
    gameId: GAME_ID,
    handleClientMessage,
    handleClientDisconnect,
    tickActiveRooms,
    ownsClient,
    hasRoomCode,
    roomMembers,
    roomCount: () => rooms.size,
  });
}
