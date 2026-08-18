import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";

import { createFactoryNetworkServer } from "./server-runtime.mjs";

function nextPayload(ws) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      cleanup();
      resolve(JSON.parse(raw.toString()));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

test("a real WebSocket preserves the legacy handshake and survives a malformed frame", async (t) => {
  const runtime = createFactoryNetworkServer({
    port: 0,
    startBridges: false,
    heartbeatIntervalMs: 0,
  });
  await runtime.start();
  t.after(async () => runtime.stop({ notifyClients: false }));

  const address = runtime.server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const connectedPromise = nextPayload(ws);
  await once(ws, "open");
  const connected = await connectedPromise;
  assert.equal(connected.event, "connected");
  assert.match(connected.clientId, /^c_[0-9a-f]{8}$/);
  assert.match(connected.sessionToken, /^s_[0-9a-f]{32}$/);
  assert.equal(connected.protocolVersion >= 2, true);
  assert.equal(connected.capabilities.includes("session-resume"), true);

  const badMessagePromise = nextPayload(ws);
  ws.send("null");
  assert.equal((await badMessagePromise).code, "BAD_MESSAGE");

  const pongPromise = nextPayload(ws);
  ws.send(JSON.stringify({ type: "ping" }));
  assert.deepEqual(await pongPromise, { event: "pong" });
  ws.close();
  await once(ws, "close");
});

test("the WebSocket server rejects frames above its configured payload limit", async (t) => {
  const runtime = createFactoryNetworkServer({
    port: 0,
    maxPayload: 128,
    startBridges: false,
    heartbeatIntervalMs: 0,
  });
  await runtime.start();
  t.after(async () => runtime.stop({ notifyClients: false }));

  const address = runtime.server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await Promise.all([once(ws, "open"), nextPayload(ws)]);
  ws.send(JSON.stringify({ type: "room_message", value: "x".repeat(512) }));
  const [code] = await once(ws, "close");
  assert.equal(code, 1009);
});

test("per-connection rate limiting rejects excess frames without changing normal replies", async (t) => {
  const runtime = createFactoryNetworkServer({
    port: 0,
    messageRate: 2,
    startBridges: false,
    heartbeatIntervalMs: 0,
  });
  await runtime.start();
  t.after(async () => runtime.stop({ notifyClients: false }));

  const address = runtime.server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await Promise.all([once(ws, "open"), nextPayload(ws)]);

  const replies = [];
  ws.on("message", (raw) => replies.push(JSON.parse(raw.toString())));
  ws.send(JSON.stringify({ type: "ping" }));
  ws.send(JSON.stringify({ type: "ping" }));
  ws.send(JSON.stringify({ type: "ping" }));
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(replies.filter((payload) => payload.event === "pong").length, 2);
  assert.equal(replies.filter((payload) => payload.code === "RATE_LIMITED").length, 1);
  ws.close();
  await once(ws, "close");
});

test("graceful shutdown gives connected games a restart event and WebSocket restart code", async () => {
  const runtime = createFactoryNetworkServer({
    port: 0,
    startBridges: false,
    heartbeatIntervalMs: 0,
  });
  await runtime.start();

  const address = runtime.server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await Promise.all([once(ws, "open"), nextPayload(ws)]);

  const restartPromise = nextPayload(ws);
  const closePromise = once(ws, "close");
  const stopPromise = runtime.stop();
  assert.deepEqual(await restartPromise, { event: "server_restarting" });
  const [code] = await closePromise;
  assert.equal(code, 1012);
  await stopPromise;
});
