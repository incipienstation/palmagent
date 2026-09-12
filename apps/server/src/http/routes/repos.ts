import { Hono } from "hono";
import { CreateRepoSchema, DiscoverQuerySchema, IdParamsSchema, PathQuerySchema } from "@palmagent/shared/requests";
import { annotate, defaultBrowseRoot, discoverRepos, listDirectory, validateRepoPath } from "../../discover.js";
import { body, parse } from "../input.js";
import type { HttpDependencies } from "../types.js";

export function repoRoutes({ service, config }: HttpDependencies) {
  const app = new Hono();
  app.get("/repos/discover", (c) => {
    const out = discoverRepos(config.repoRoots, parse(DiscoverQuerySchema, c.req.query()).refresh === "1");
    return c.json({ repos: annotate(out.repos, service.listRepos()), roots: config.repoRoots, scannedAt: out.scannedAt });
  });
  app.get("/repos/validate", (c) => c.json(validateRepoPath(parse(PathQuerySchema, c.req.query()).path ?? "", config.repoRoots, service.listRepos())));
  app.get("/fs/list", (c) => c.json(listDirectory(parse(PathQuerySchema, c.req.query()).path || defaultBrowseRoot(config.repoRoots), config.repoRoots)));
  app.get("/repos", (c) => c.json({ repos: service.listRepos() }));
  app.post("/repos", async (c) => c.json({ repo: service.createRepo(await body(c, CreateRepoSchema)) }, 201));
  app.delete("/repos/:id", (c) => c.json({ repo: service.deleteRepo(parse(IdParamsSchema, c.req.param()).id) }));
  return app;
}
