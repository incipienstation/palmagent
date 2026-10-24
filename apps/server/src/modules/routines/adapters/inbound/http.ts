import { Hono } from "hono";
import { CreateRoutineSchema, IdParamsSchema, UpdateRoutineSchema } from "@palmagent/shared/requests";
import { jsonBody, params } from "../../../../platform/http/input.js";
import type { HttpDependencies } from "./http-dependencies.js";

export function routineRoutes({ routines }: Pick<HttpDependencies, "routines">) {
  const app = new Hono();
  return app
    .get("/", async (c) => c.json({ routines: await routines.list() }, 200))
    .post("/", jsonBody(CreateRoutineSchema), async (c) => c.json({ routine: await routines.create(c.req.valid("json")) }, 201))
    .get("/:id", params(IdParamsSchema), async (c) => c.json({ routine: await routines.get(c.req.valid("param").id) }, 200))
    .patch("/:id", params(IdParamsSchema), jsonBody(UpdateRoutineSchema), async (c) => c.json({ routine: await routines.update(c.req.valid("param").id, c.req.valid("json")) }, 200))
    .delete("/:id", params(IdParamsSchema), async (c) => c.json({ routine: await routines.remove(c.req.valid("param").id) }, 200))
    .post("/:id/run", params(IdParamsSchema), async (c) => c.json({ routine: await routines.runNow(c.req.valid("param").id) }, 200))
    .post("/:id/stop", params(IdParamsSchema), async (c) => c.json({ routine: await routines.stopRun(c.req.valid("param").id) }, 200))
    .get("/:id/runs", params(IdParamsSchema), async (c) => c.json({ runs: await routines.runs(c.req.valid("param").id) }, 200));
}
