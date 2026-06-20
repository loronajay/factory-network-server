// Low-level send + id/room-code generation. Depends only on the shared state.
import crypto from "crypto";
import { clients, rooms, lobbies } from "./state.mjs";

export function makeId(prefix = "") {
  return prefix + crypto.randomBytes(4).toString("hex");
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

export function send(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function sendToClient(clientId, payload) {
  const ws = clients.get(clientId);
  if (ws) send(ws, payload);
}
