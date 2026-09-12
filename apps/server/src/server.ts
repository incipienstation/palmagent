import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { BRANDING } from "@palmagent/shared";
import { createApp } from "./http/app.js";
import { createRuntime } from "./runtime.js";
import { startSessionControl } from "./session-control.js";

declare const __PALMAGENT_BUILD__: { version: string; sourceCommit: string; dirty: boolean };
const build = typeof __PALMAGENT_BUILD__ === "undefined" ? undefined : __PALMAGENT_BUILD__;
const runtime = await createRuntime();
const shutdown = new AbortController();
const app = createApp({ ...runtime, build, shutdown: shutdown.signal });
const server = createServer(getRequestListener(app.fetch));
let local: Server | undefined;
let closing: Promise<void> | undefined;

function closeServer(listener: Server): Promise<void> {
  if (!listener.listening) return Promise.resolve();
  return new Promise((resolve) => {
    const deadline = setTimeout(() => listener.closeAllConnections(), 3000);
    listener.close(() => { clearTimeout(deadline); resolve(); });
  });
}
function close() {
  return closing ??= (async () => {
    shutdown.abort(); // stop admission and release SSE subscriptions first
    await Promise.all([closeServer(server), ...(local ? [closeServer(local)] : [])]);
    await runtime.close();
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void close().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); }); });
}
try {
  local = await startSessionControl(dirname(runtime.config.dbPath), runtime.service);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(runtime.config.port, runtime.config.host, () => { server.off("error", reject); resolve(); });
  });
  runtime.start();
  console.log(`${BRANDING.productName} internal listener on ${runtime.config.host}:${runtime.config.port}  ·  TLS required at the public edge  ·  db=${runtime.config.dbPath}  ·  cap=${runtime.config.concurrency}`);
} catch (error) { await close(); throw error; }
