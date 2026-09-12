import { Hono, type Context } from "hono";
import { CreateRoutineSchema, IdParamsSchema, UpdateRoutineSchema } from "@palmagent/shared/requests";
import { body, parse } from "../input.js";
import type { HttpDependencies } from "../types.js";

export function routineRoutes({ routines }: HttpDependencies) {
  const app = new Hono();
  const id = (c: Context) => parse(IdParamsSchema, c.req.param()).id;
  app.get("/", (c) => c.json({ routines: routines.list() }));
  app.post("/", async (c) => c.json({ routine: routines.create(await body(c, CreateRoutineSchema)) }, 201));
  app.get("/:id", (c) => c.json({ routine: routines.get(id(c)) }));
  app.patch("/:id", async (c) => c.json({ routine: routines.update(id(c), await body(c, UpdateRoutineSchema)) }));
  app.delete("/:id", (c) => c.json({ routine: routines.remove(id(c)) }));
  app.post("/:id/run", (c) => c.json({ routine: routines.runNow(id(c)) }));
  app.get("/:id/runs", (c) => c.json({ runs: routines.runs(id(c)) }));
  return app;
}
