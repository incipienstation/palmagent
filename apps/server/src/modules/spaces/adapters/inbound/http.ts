import { Hono } from "hono";
import { CreateRepoSchema, UpdateRepoSchema, DiscoverQuerySchema, IdParamsSchema, PathQuerySchema } from "@palmagent/shared/requests";
import { jsonBody, query, params } from "../../../../platform/http/input.js";
import type { HttpDependencies } from "./http-dependencies.js";

export function repoRoutes({ service, discovery }: Pick<HttpDependencies, "service" | "discovery">) {
  const app = new Hono();
  return app
    .get("/repos/discover", query(DiscoverQuerySchema), (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(discovery.discover(c.req.valid("query").refresh === "1"), 200);
    })
    .get("/repos/validate", query(PathQuerySchema), c => c.json(discovery.validate(c.req.valid("query").path ?? ""), 200))
    .get("/fs/list", query(PathQuerySchema), c => c.json(discovery.browse(c.req.valid("query").path), 200))
    .get("/repos", (c) => c.json({ repos: service.listRepos() }, 200))
    .post("/repos", jsonBody(CreateRepoSchema), async (c) => c.json({ repo: await service.createRepo(c.req.valid("json")) }, 201))
    .patch("/repos/:id", params(IdParamsSchema), jsonBody(UpdateRepoSchema), c => c.json({ repo: service.updateRepo(c.req.valid("param").id, c.req.valid("json")) }, 200))
    .delete("/repos/:id", params(IdParamsSchema), (c) => c.json({ repo: service.deleteRepo(c.req.valid("param").id) }, 200));
}
