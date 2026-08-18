export const PROTOCOL_VERSION = 2;
export const CONNECTED_CAPABILITIES = Object.freeze([
  "lobbies-v2",
  "display-lobbies",
  "session-resume",
  "queue-status",
  "server-restart-notice",
]);

const FIELD_LIMITS = Object.freeze({
  gameId: 64,
  roomCode: 16,
  messageType: 96,
  targetId: 128,
  clientId: 128,
  sessionToken: 128,
});

function invalid(message) {
  return { ok: false, message };
}

export function validateClientFrame(frame) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    return invalid("Message must be a JSON object");
  }
  if (typeof frame.type !== "string" || !frame.type.trim() || frame.type.length > 64) {
    return invalid("Message type must be a non-empty string of at most 64 characters");
  }

  for (const [field, maxLength] of Object.entries(FIELD_LIMITS)) {
    if (frame[field] === undefined || frame[field] === null) continue;
    if (String(frame[field]).length > maxLength) {
      return invalid(`${field} is too long`);
    }
  }

  for (const field of ["settings", "identity"]) {
    if (frame[field] === undefined) continue;
    if (!frame[field] || typeof frame[field] !== "object" || Array.isArray(frame[field])) {
      return invalid(`${field} must be a JSON object`);
    }
  }

  return { ok: true };
}
