import { Hono } from "hono";
import { CreateRoutineSchema, IdParamsSchema, UpdateRoutineSchema } from "@palmagent/shared/requests";
import { jsonBody, params } from "../input.js";
import type { HttpDependencies } from "../types.js";

export function routineRoutes({ routines }: Pick<HttpDependencies, "routines">) {
  const app = new Hono();
  return app
    .get("/", (c) => c.json({ routines: routines.list() }, 200))
    .post("/", jsonBody(CreateRoutineSchema), (c) => c.json({ routine: routines.create(c.req.valid("json")) }, 201))
    .get("/:id", params(IdParamsSchema), (c) => c.json({ routine: routines.get(c.req.valid("param").id) }, 200))
    .patch("/:id", params(IdParamsSchema), jsonBody(UpdateRoutineSchema), (c) => c.json({ routine: routines.update(c.req.valid("param").id, c.req.valid("json")) }, 200))
    .delete("/:id", params(IdParamsSchema), (c) => c.json({ routine: routines.remove(c.req.valid("param").id) }, 200))
    .post("/:id/run", params(IdParamsSchema), (c) => c.json({ routine: routines.runNow(c.req.valid("param").id) }, 200))
    .post("/:id/stop", params(IdParamsSchema), async (c) => c.json({ routine: await routines.stopRun(c.req.valid("param").id) }, 200))
    .get("/:id/runs", params(IdParamsSchema), (c) => c.json({ runs: routines.runs(c.req.valid("param").id) }, 200));
}
