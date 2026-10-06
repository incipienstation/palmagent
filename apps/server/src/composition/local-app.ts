import { CreateTerminal, RenameTerminal, TerminalId } from "@palmagent/shared/terminals";
import { z } from "zod";
import { params } from "../platform/http/input.js";
import { ApplicationError } from "../kernel/errors.js";
import type { TerminalService } from "../modules/terminals/application/use-cases/terminal-service.js";
import type { RoutineService } from "../modules/routines/application/use-cases/routine-service.js";
import { routineRoutes } from "../modules/routines/adapters/inbound/http.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DispatchSessionSchema } from "@palmagent/shared/requests";
import { jsonBody } from "../platform/http/input.js";
import { handleError } from "../platform/http/errors.js";
import type { TaskService } from "../modules/tasks/application/use-cases/task-service.js";

// A separate app: never mount this capability on the browser's TCP listener.
export function createSessionApp(service: Pick<TaskService, "dispatchSession">, terminals?: TerminalService, routines?: RoutineService) {
  const app = new Hono();
  app.onError(handleError);
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.use("*", bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: "request body too large" }, 413) }));
  const terminalService = () => { if (!terminals) throw new ApplicationError("service_unavailable", "Terminals unavailable"); return terminals; };
  const id = params(z.object({ id: TerminalId }));
  app.get("/terminals", c => c.json({ terminals: terminalService().list(), capabilities: terminalService().capabilities() }))
    .post("/terminals", jsonBody(CreateTerminal), async c => c.json({ terminal: await terminalService().create(c.req.valid("json")) }, 201))
    .patch("/terminals/:id", id, jsonBody(RenameTerminal), c => c.json({ terminal: terminalService().rename(c.req.valid("param").id, c.req.valid("json").title) }))
    .post("/terminals/:id/terminate", id, async c => c.json({ terminal: await terminalService().terminate(c.req.valid("param").id) }));
  if (routines) {
    app.route("/routines", routineRoutes({ routines }));
    app.get("/routine-spaces", c => c.json(routines.context()));
  }
  return app.post("/dispatch", jsonBody(DispatchSessionSchema), async (c) =>
    c.json({ task: await service.dispatchSession(c.req.valid("json")) }, 200));
}
