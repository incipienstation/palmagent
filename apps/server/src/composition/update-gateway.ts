import { getRequestListener } from "@hono/node-server";
import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CreateTaskSchema, IdParamsSchema } from "@palmagent/shared/requests";
import { HOST_INGRESS_REQUIREMENTS, SubmitMessageSchema } from "@palmagent/shared";
import { SqliteAuth } from "../modules/auth/adapters/outbound/sqlite-auth.js";
import { AuthService } from "../modules/auth/application/use-cases/auth-service.js";
import { webauthn } from "../modules/auth/adapters/outbound/webauthn.js";
import { SqliteAdmissionInbox } from "../modules/tasks/adapters/outbound/sqlite-admission.js";
import { admitDuringUpdate } from "../modules/tasks/adapters/inbound/update-admission.js";
import { attachmentBody } from "../modules/tasks/adapters/inbound/attachment-body.js";
import { authenticate, requireCurrentClient, securityHeaders } from "../platform/http/middleware.js";
import { handleError } from "../platform/http/errors.js";
import { params } from "../platform/http/input.js";
import { handoffSocket } from "../platform/http/handoff-socket.js";
import { config, validateConfig } from "./config.js";

/** The updater lends a listener across an API-owner switch. Raw forwarding keeps
 * the normal auth, SSE and terminal transports on the current Task owner. */
export async function startUpdateGateway(build: {version: string; sourceCommit: string; dirty: boolean}) {
  validateConfig();
  if (!config.authEnabled) throw new Error("Update admission requires authenticated sessions");
  const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
  const auth = new AuthService(new SqliteAuth(db), config, webauthn);
  const sessionValid = (token?: string) => auth.sessionValid(token);
  const runtime = { config, build, auth: { enabled: true, origin: auth.origin, verifySession: sessionValid, sessionValid } };
  const inbox = new SqliteAdmissionInbox(join(config.dataDir, "update-inbox.sqlite"));
  const admission = { inbox, deferring: () => true };
  const app = new Hono();
  const unavailable = () => Response.json({ error: "Application owner is restarting", code: "update_in_progress" }, {
    status: 503, headers: { "cache-control": "no-store", "retry-after": "1" },
  });
  app.onError(handleError);
  app.use("*", securityHeaders(auth.origin), authenticate(runtime), requireCurrentClient(runtime));
  app.use("*", bodyLimit({ maxSize: HOST_INGRESS_REQUIREMENTS.maxBodyBytes, onError: c => c.json({error: "Request body too large"}, 413) }));
  app.post("/api/tasks", attachmentBody(CreateTaskSchema), c => admitDuringUpdate(c, admission, { kind: "create", input: c.req.valid("json") }) ?? unavailable());
  app.post("/api/tasks/:id/messages", params(IdParamsSchema), attachmentBody(SubmitMessageSchema), c =>
    admitDuringUpdate(c, admission, {kind: "message", taskId: c.req.valid("param").id, input: c.req.valid("json")}) ?? unavailable());
  app.all("*", unavailable);
  const fallback = createHttpServer(getRequestListener(app.fetch));
  const sockets = new Set<Socket>();
  const gateway = createServer({ pauseOnConnect: true }, client => {
    sockets.add(client);
    const owner = createConnection(handoffSocket(config.dataDir));
    let connected = false;
    client.on("error", () => client.destroy());
    client.once("close", () => { sockets.delete(client); owner.destroy(); });
    owner.once("connect", () => {
      connected = true;
      owner.pipe(client);
      client.pipe(owner);
    });
    owner.on("error", (error: NodeJS.ErrnoException) => {
      if (!connected && !client.destroyed && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
        fallback.emit("connection", client);
        client.resume();
      } else client.destroy();
    });
    owner.once("close", () => { if (connected) client.destroy(); });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      gateway.once("error", reject);
      gateway.listen({ host: config.host, port: config.port, reusePort: true }, () => { gateway.off("error", reject); resolve(); });
    });
  } catch (error) { inbox.close(); db.close(); throw error; }
  return async () => {
    const closed = new Promise<void>(resolve => gateway.close(() => resolve()));
    for (const client of sockets) client.destroy();
    await closed;
    inbox.close(); db.close();
  };
}
