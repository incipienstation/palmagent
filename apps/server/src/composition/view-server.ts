import { createServer } from "node:http";
import { chmodSync } from "node:fs";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { staticFiles } from "../platform/http/static.js";

/** PWA files only. No runtime composition, database, API, credentials or control routes. */
export async function startViewServer(socket: string, directory: string) {
  const app = new Hono();
  app.get("*", staticFiles(directory));
  const server = createServer(getRequestListener(app.fetch));
  const mask = process.umask(0o077);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => { chmodSync(socket, 0o600); resolve(); });
    });
  } finally { process.umask(mask); }
  return { close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
