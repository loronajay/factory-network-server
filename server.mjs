// Factory Network production bootstrap. The reusable runtime lives separately
// so tests can bind an ephemeral port and shut down cleanly.
import { pathToFileURL } from "node:url";

import { createFactoryNetworkServer } from "./src/server-runtime.mjs";

const runtime = createFactoryNetworkServer();
const { app, server, wss } = runtime;

async function start() {
  const address = await runtime.start();
  const port = typeof address === "object" && address ? address.port : address;
  console.log(`Factory Network server listening on port ${port}`);
}

function installShutdownSignal(signal) {
  process.once(signal, async () => {
    try {
      await runtime.stop();
      process.exitCode = 0;
    } catch (error) {
      console.error(`[server] ${signal} shutdown:`, error);
      process.exitCode = 1;
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  installShutdownSignal("SIGINT");
  installShutdownSignal("SIGTERM");
  start().catch((error) => {
    console.error("[server] startup:", error);
    process.exitCode = 1;
  });
}

export { app, server, wss, runtime, start };
