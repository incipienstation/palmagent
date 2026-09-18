import { Hono } from "hono";
import { CreateRepoSchema, DiscoverQuerySchema, IdParamsSchema, PathQuerySchema } from "@palmagent/shared/requests";
import { annotate, defaultBrowseRoot, discoverRepos, listDirectory, validateRepoPath } from "../../discover.js";
import { jsonBody, query, params } from "../input.js";
import type { HttpDependencies } from "../types.js";

export function repoRoutes({ service, settings }: HttpDependencies) {
  const app = new Hono();
  return app
    .get("/repos/discover", query(DiscoverQuerySchema), (c) => {
      const roots = settings.get().repoRoots;
      const out = discoverRepos(roots, c.req.valid("query").refresh === "1");
      c.header("Cache-Control", "no-store");
      return c.json({ repos: annotate(out.repos, service.listRepos()), roots, scannedAt: out.scannedAt }, 200);
    })
    .get("/repos/validate", query(PathQuerySchema), (c) => c.json(validateRepoPath(c.req.valid("query").path ?? "", settings.get().repoRoots, service.listRepos()), 200))
    .get("/fs/list", query(PathQuerySchema), (c) => {
      const roots = settings.get().repoRoots;
      return c.json(listDirectory(c.req.valid("query").path || defaultBrowseRoot(roots), roots), 200);
    })
    .get("/repos", (c) => c.json({ repos: service.listRepos() }, 200))
    .post("/repos", jsonBody(CreateRepoSchema), (c) => c.json({ repo: service.createRepo(c.req.valid("json")) }, 201))
    .delete("/repos/:id", params(IdParamsSchema), (c) => c.json({ repo: service.deleteRepo(c.req.valid("param").id) }, 200));
}
