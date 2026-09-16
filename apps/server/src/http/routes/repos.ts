import { Hono } from "hono";
import { CreateRepoSchema, DiscoverQuerySchema, IdParamsSchema, PathQuerySchema } from "@palmagent/shared/requests";
import { annotate, defaultBrowseRoot, discoverRepos, listDirectory, validateRepoPath } from "../../discover.js";
import { body, parse } from "../input.js";
import type { HttpDependencies } from "../types.js";

export function repoRoutes({ service, settings }: HttpDependencies) {
  const app = new Hono();
  app.get("/repos/discover", (c) => {
    const roots = settings.get().repoRoots;
    const out = discoverRepos(roots, parse(DiscoverQuerySchema, c.req.query()).refresh === "1");
    c.header("Cache-Control", "no-store");
    return c.json({ repos: annotate(out.repos, service.listRepos()), roots, scannedAt: out.scannedAt });
  });
  app.get("/repos/validate", (c) => c.json(validateRepoPath(parse(PathQuerySchema, c.req.query()).path ?? "", settings.get().repoRoots, service.listRepos())));
  app.get("/fs/list", (c) => {
    const roots = settings.get().repoRoots;
    return c.json(listDirectory(parse(PathQuerySchema, c.req.query()).path || defaultBrowseRoot(roots), roots));
  });
  app.get("/repos", (c) => c.json({ repos: service.listRepos() }));
  app.post("/repos", async (c) => c.json({ repo: service.createRepo(await body(c, CreateRepoSchema)) }, 201));
  app.delete("/repos/:id", (c) => c.json({ repo: service.deleteRepo(parse(IdParamsSchema, c.req.param()).id) }));
  return app;
}
