// Low-level send + id/room-code generation. Depends only on the shared state.
import crypto from "crypto";
import { clients, rooms, lobbies } from "./state.mjs";

export const DEFAULT_MAX_BUFFERED_AMOUNT = 1_048_576;

export function makeId(prefix = "", byteLength = 4) {
  return prefix + crypto.randomBytes(byteLength).toString("hex");
}

export function makeRoomCode(length = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export function uniqueRoomCode() {
  let code = makeRoomCode();
  while (rooms.has(code) || lobbies.has(code)) code = makeRoomCode();
  return code;
}

export function send(ws, payload, { maxBufferedAmount = DEFAULT_MAX_BUFFERED_AMOUNT } = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  if (Number(ws.bufferedAmount || 0) > maxBufferedAmount) {
    try {
      ws.close?.(1013, "Client is not keeping up");
    } catch {
      ws.terminate?.();
    }
    return false;
  }
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function sendToClient(clientId, payload) {
  const ws = clients.get(clientId);
  return ws ? send(ws, payload) : false;
}
