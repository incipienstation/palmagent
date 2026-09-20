import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { CreateTerminal, RenameTerminal, TerminalId, TerminalQuery } from "@palmagent/shared/terminals";
import { publicTerminal } from "../../terminal/store.js";
import { HttpError } from "../../service.js";
import { jsonBody, params, query } from "../input.js";
import type { HttpDependencies } from "../types.js";

const idParams = params(z.object({ id: TerminalId }));
export function terminalRoutes(deps: Pick<HttpDependencies, "auth" | "terminals" | "terminalTickets" | "config">) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (!deps.auth.enabled) throw new HttpError(403, "Sign in must be enabled for shell access");
    if (c.req.method !== "GET" && c.req.header("origin") !== deps.auth.origin) throw new HttpError(403, "Same-origin request required");
    await next();
  });
  const service = () => { if (!deps.terminals) throw new HttpError(503, "Terminals unavailable"); return deps.terminals; };
  return app
    .get("/", query(TerminalQuery), c => c.json({ terminals: service().list(c.req.valid("query")), capabilities: service().capabilities() }, 200))
    .post("/", jsonBody(CreateTerminal), async c => c.json({ terminal: await service().create(c.req.valid("json")) }, 201))
    .get("/:id", idParams, c => c.json({ terminal: publicTerminal(service().get(c.req.valid("param").id)) }, 200))
    .patch("/:id", idParams, jsonBody(RenameTerminal), c => c.json({ terminal: service().rename(c.req.valid("param").id, c.req.valid("json").title) }, 200))
    .post("/:id/terminate", idParams, async c => c.json({ terminal: await service().terminate(c.req.valid("param").id) }, 200))
    .post("/:id/attach-ticket", idParams, c => {
      const id = c.req.valid("param").id;
      service().get(id);
      const token = getCookie(c, deps.config.cookieName);
      if (!token || !deps.auth.sessionValid(token) || !deps.terminalTickets) throw new HttpError(401, "Authentication required");
      return c.json(deps.terminalTickets.issue(token, id), 200);
    });
}
