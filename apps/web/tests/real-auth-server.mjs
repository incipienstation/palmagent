// One real HTTPS fixture for the transport migration's passkey regression test.
// The parent supplies a fresh temporary directory and an isolated environment.
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = process.env.HTTP_TEST_DIR;
if (!dir) throw new Error("HTTP_TEST_DIR is required");
const key = join(dir, "key.pem");
const cert = join(dir, "cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
  "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) });
await new Promise((resolve) => server.listen(0, "localhost", resolve));
const origin = `https://localhost:${server.address().port}`;
Object.assign(process.env, { AUTH_ENABLED: "1", AUTH_RP_ID: "localhost", AUTH_ORIGIN: origin,
  DISPATCHER_DATA_DIR: join(dir, "state"), REPO_ROOTS: dir, STATIC_DIR: resolve("../web/dist") });
const { createRuntime } = await import("../../server/src/runtime.ts");
const { createApp } = await import("../../server/src/http/app.ts");
const { getRequestListener } = await import("../../server/node_modules/@hono/node-server/dist/index.mjs");
const runtime = await createRuntime();
const shutdown = new AbortController();
server.on("request", getRequestListener(createApp({ ...runtime, shutdown: shutdown.signal }).fetch));
process.send({ origin, token: runtime.auth.mintEnrollToken().token });
process.once("SIGTERM", async () => {
  shutdown.abort();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await runtime.close();
  process.exit(0);
});
