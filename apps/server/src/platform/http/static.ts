import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { MiddlewareHandler } from "hono";

export function staticFiles(directory: string, previousWeb?: string): MiddlewareHandler {
  const root = resolve(directory);
  if (!existsSync(join(root, "index.html"))) return async (_c, next) => next();
  const realRoot = realpathSync(root);
  const outside = (base: string, path: string) => { const rel = relative(base, path); return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel); };
  const files = serveStatic({ root });
  const previousFiles = previousWeb ? serveStatic({ root: previousWeb }) : undefined;
  const shell = serveStatic({ path: join(root, "index.html") });
  return async (c, next) => {
    if (c.req.method !== "GET" || c.req.path.startsWith("/api/")) return next();
    let path = resolve(root, `.${decodeURIComponent(c.req.path)}`);
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (outside(root, path) || (existsSync(path) && outside(realRoot, realpathSync(path)))) return c.json({ error: "not found" }, 404);
    let response = await files(c, async () => {});
    const asset = relative(root, path).startsWith(`assets${sep}`);
    if (!response && asset) {
      // Only exact asset filenames may come from the retained release.
      const name = c.req.path;
      if (previousFiles && previousWeb && /^\/assets\/[\w.-]+$/.test(name)) {
        const old = join(previousWeb, name);
        if (existsSync(old) && realpathSync(old) === old && statSync(old).isFile())
          response = await previousFiles(c, async () => {});
      }
    }
    const immutable = asset && !!response;
    response ??= await shell(c, async () => {});
    if (!response) return next();
    response.headers.set("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
    return response;
  };
}
