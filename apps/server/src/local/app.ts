import { CreateTerminal, RenameTerminal, TerminalId } from "@palmagent/shared/terminals";
import { z } from "zod";
import { params } from "../http/input.js";
import { HttpError } from "../service.js";
import type { TerminalService } from "../terminal/service.js";
import type { RoutineService } from "../routines.js";
import { routineRoutes } from "../http/routes/routines.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DispatchSessionSchema } from "@palmagent/shared/requests";
import { jsonBody } from "../http/input.js";
import { handleError } from "../http/errors.js";
import type { TaskService } from "../service.js";

// A separate app: never mount this capability on the browser's TCP listener.
export function createSessionApp(service: Pick<TaskService, "dispatchSession">, terminals?: TerminalService, routines?: RoutineService) {
  const app = new Hono();
  app.onError(handleError);
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.use("*", bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: "request body too large" }, 413) }));
  const terminalService = () => { if (!terminals) throw new HttpError(503, "Terminals unavailable"); return terminals; };
  const id = params(z.object({ id: TerminalId }));
  app.get("/terminals", c => c.json({ terminals: terminalService().list(), capabilities: terminalService().capabilities() }))
    .post("/terminals", jsonBody(CreateTerminal), async c => c.json({ terminal: await terminalService().create(c.req.valid("json")) }, 201))
    .patch("/terminals/:id", id, jsonBody(RenameTerminal), c => c.json({ terminal: terminalService().rename(c.req.valid("param").id, c.req.valid("json").title) }))
    .post("/terminals/:id/terminate", id, async c => c.json({ terminal: await terminalService().terminate(c.req.valid("param").id) }));
  if (routines) {
    app.route("/routines", routineRoutes({ routines }));
    app.get("/routine-spaces", c => c.json(routines.context()));
  }
  return app.post("/dispatch", jsonBody(DispatchSessionSchema), (c) =>
    c.json({ task: service.dispatchSession(c.req.valid("json")) }, 200));
}
