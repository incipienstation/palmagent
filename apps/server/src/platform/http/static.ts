import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { MiddlewareHandler } from "hono";

export function staticFiles(directory: string): MiddlewareHandler {
  const root = resolve(directory);
  if (!existsSync(join(root, "index.html"))) return async (_c, next) => next();
  const realRoot = realpathSync(root);
  const outside = (base: string, path: string) => { const rel = relative(base, path); return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel); };
  const files = serveStatic({ root });
  const shell = serveStatic({ path: join(root, "index.html") });
  return async (c, next) => {
    if (c.req.method !== "GET" || c.req.path.startsWith("/api/")) return next();
    let path = resolve(root, `.${decodeURIComponent(c.req.path)}`);
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (outside(root, path) || (existsSync(path) && outside(realRoot, realpathSync(path)))) return c.json({ error: "not found" }, 404);
    let response = await files(c, async () => {});
    const asset = !!response && relative(root, path).startsWith(`assets${sep}`);
    response ??= await shell(c, async () => {});
    if (!response) return next();
    response.headers.set("cache-control", asset ? "public, max-age=31536000, immutable" : "no-cache");
    return response;
  };
}
