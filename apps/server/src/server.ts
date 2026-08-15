import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { BRANDING } from "@palmagent/shared";
import type { PushSubscriptionJson, TaskStatus } from "@palmagent/shared";
import { AuthService } from "./auth.js";
import { config, validateConfig } from "./config.js";
import { Db } from "./db.js";
import type { EventRow } from "./db.js";
import { DaemonBackend } from "./daemon-client.js";
import { annotate, defaultBrowseRoot, discoverRepos, listDirectory, validateRepoPath } from "./discover.js";
import { GithubService } from "./github.js";
import { Hub } from "./hub.js";
import { InProcessBackend } from "./inproc-backend.js";
import { PushService } from "./push.js";
import { RoutineService } from "./routines.js";
import { HttpError, TaskService } from "./service.js";
import { ProcessSupervisor } from "./supervisor.js";
import type { RunnerBackend } from "./types.js";
import { WorktreeManager } from "./worktree.js";

// Pick the process backend: the runner daemon (so a deploy can restart this web
// server without killing in-flight turns) when RUNNER_SOCKET is set AND reachable,
// else spawn the CLIs in-process (development, or a degraded fallback if the
// daemon is down).
async function selectBackend(): Promise<RunnerBackend> {
  if (config.runnerSocket) {
    const daemon = new DaemonBackend(config.runnerSocket);
    if (await daemon.init()) {
      console.log(`[runner] using daemon backend at ${config.runnerSocket}`);
      return daemon;
    }
    console.warn(`[runner] daemon at ${config.runnerSocket} unreachable — falling back to in-process (no deploy survival)`);
  }
  return new InProcessBackend();
}

// Refuse to boot on missing required config — never silently fall back to a
// personal/host-specific value (see config.ts validateConfig).
validateConfig();

// ---- wiring: SQLite (metadata + event log) → Hub (live SSE fan-out) ----
const db = new Db(config.dbPath);
const hub = new Hub();
const supervisor = new ProcessSupervisor(config.concurrency);
const worktrees = new WorktreeManager();
const push = new PushService(db, config.vapidKeyPath ?? join(dirname(config.dbPath), "vapid.json"), config.pushSubject);
const backend = await selectBackend();
const service = new TaskService(db, hub, supervisor, backend, worktrees, push);
await service.init(); // hydrate + restart recovery (reattach live daemon turns)
const routines = new RoutineService(db, service);
routines.start(); // cron ticker (skips runs missed while down)
const github = new GithubService(service, config.githubToken);
service.attachGithub(github);
github.start(); // poll PR lifecycle/checks (fail-soft: no token ⇒ links only)
const auth = new AuthService(db);

// ---------------------------------------------------------------- HTTP helpers
function sendJson(res: ServerResponse, status: number, obj: unknown, cookies?: string[]) {
  const headers: Record<string, string | string[]> = { "content-type": "application/json" };
  if (cookies?.length) headers["set-cookie"] = cookies;
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

// Optional string field off a request body — anything non-string becomes undefined.
const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// Big enough for several base64 image attachments (sanitizeImages enforces the
// real per-image/count limits). NB: nginx in front needs client_max_body_size
// raised to match.
const MAX_BODY_BYTES = 48_000_000;

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    let aborted = false;
    req.on("data", (c) => {
      data += c;
      if (data.length > MAX_BODY_BYTES && !aborted) {
        aborted = true; // explicit 413, then drop the socket (don't hang on a never-fired 'end')
        reject(new HttpError(413, "request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (aborted) return;
      let parsed: unknown;
      try {
        parsed = data ? JSON.parse(data) : {};
      } catch {
        return reject(new HttpError(400, "invalid JSON body"));
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return reject(new HttpError(400, "body must be a JSON object"));
      }
      resolve(parsed as Record<string, unknown>);
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------- SSE
// Frame shapes match @palmagent/shared SseFrame. `event` frames carry an
// `id:` (global events.id on the inbox stream, per-task seq on a scoped stream)
// so EventSource resumes via Last-Event-ID. `tasks` snapshots carry no id.
// Writes swallow their own errors: a client that vanished mid-stream must not
// throw back into the event-ingest path (the 'close' handler unsubscribes it).
function writeEvent(res: ServerResponse, row: EventRow, scoped: boolean) {
  const id = scoped ? row.seq : row.id;
  try {
    res.write(`id: ${id}\ndata: ${JSON.stringify({ type: "event", event: row.event })}\n\n`);
  } catch {
    /* socket gone */
  }
}
function writeTasks(res: ServerResponse) {
  try {
    res.write(`data: ${JSON.stringify({ type: "tasks", tasks: service.listTasks() })}\n\n`);
  } catch {
    /* socket gone */
  }
}

function handleStream(req: IncomingMessage, res: ServerResponse, url: URL) {
  const taskId = url.searchParams.get("task") || undefined;
  if (taskId) {
    try {
      service.getTask(taskId);
    } catch {
      sendJson(res, 404, { error: `no such task: ${taskId}` });
      return;
    }
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no", // tell nginx & friends not to buffer the stream
  });
  res.write(": connected\n\n");

  // Browsers resend the last `id:` as Last-Event-ID; allow ?lastEventId= too.
  const lastId = Number(req.headers["last-event-id"] ?? url.searchParams.get("lastEventId") ?? 0) || 0;

  writeTasks(res); // current state up front
  const missed = taskId ? db.eventsAfterSeq(taskId, lastId) : db.eventsAfterGlobal(lastId);
  for (const row of missed) writeEvent(res, row, !!taskId); // replay from DB

  const offEvent = hub.onEvent((row) => {
    if (taskId && row.event.taskId !== taskId) return;
    writeEvent(res, row, !!taskId);
  });
  const offTasks = hub.onTasks(() => writeTasks(res));
  const keepAlive = setInterval(() => {
    try {
      res.write(":keep-alive\n\n");
    } catch {
      /* connection gone */
    }
  }, config.keepAliveMs);

  const close = () => {
    clearInterval(keepAlive);
    offEvent();
    offTasks();
  };
  req.on("close", close);
  res.on("close", close);
}

// ------------------------------------------------------------------- statics
// Serve the built PWA when STATIC_DIR points at a web build. The server package
// has no placeholder UI; without a build, API routes remain available.
const STATIC_DIR = existsSync(join(config.staticDir, "index.html")) ? config.staticDir : undefined;
const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".txt": "text/plain", ".woff2": "font/woff2", ".map": "application/json",
};

async function serveStatic(res: ServerResponse, urlPath: string): Promise<boolean> {
  if (!STATIC_DIR) return false;
  // Normalize + contain: no path may escape the dist dir.
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\.])+/, "");
  const file = join(STATIC_DIR, rel === "" ? "index.html" : rel);
  if (!file.startsWith(STATIC_DIR)) return false;
  const candidate = existsSync(file) && extname(file) ? file : join(STATIC_DIR, "index.html");
  try {
    const body = await readFile(candidate);
    const ext = extname(candidate);
    // The SW + shell must revalidate every load (else updates never land);
    // hashed assets are immutable.
    const cache = candidate.includes(`${join(STATIC_DIR, "assets")}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache";
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": cache });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------- router
const TASK_ROUTE = /^\/api\/tasks\/([^/]+)(?:\/(followup|steer|approve|answer|stop|cancel))?$/;
const ROUTINE_ROUTE = /^\/api\/routines\/([^/]+)(?:\/(run|runs))?$/;

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  // statics: the built PWA when present
  if (method === "GET" && !path.startsWith("/api/")) {
    if (await serveStatic(res, path)) return;
  }

  // ---- auth: unauthenticated health + the always-reachable login/enroll API ----
  // (These must never be gated — they are how you become authenticated.)
  if (path === "/api/health" && method === "GET") return sendJson(res, 200, { ok: true });
  if (path.startsWith("/api/auth/")) {
    try {
      if (path === "/api/auth/me" && method === "GET") return sendJson(res, 200, auth.status(req));
      if (path === "/api/auth/login/options" && method === "POST") {
        const { options, setCookie } = await auth.beginAuthentication();
        return sendJson(res, 200, options, [setCookie]);
      }
      if (path === "/api/auth/login/verify" && method === "POST") {
        const body = await readBody(req);
        const { setCookies } = await auth.finishAuthentication(req, body as unknown as AuthenticationResponseJSON);
        return sendJson(res, 200, { ok: true }, setCookies);
      }
      if (path === "/api/auth/register/options" && method === "POST") {
        const body = await readBody(req);
        const { options, setCookie } = await auth.beginRegistration(req, body.token ? String(body.token) : undefined);
        return sendJson(res, 200, options, [setCookie]);
      }
      if (path === "/api/auth/register/verify" && method === "POST") {
        const body = await readBody(req);
        const { setCookies } = await auth.finishRegistration(
          req,
          body.response as unknown as RegistrationResponseJSON,
          body.label ? String(body.label) : undefined,
        );
        return sendJson(res, 201, { ok: true }, setCookies);
      }
      if (path === "/api/auth/logout" && method === "POST") {
        return sendJson(res, 200, { ok: true }, [auth.logout(req)]);
      }
      if (path === "/api/auth/enroll-token" && method === "POST") {
        // "Add another device" — only a logged-in session may mint a token in-app.
        if (auth.enabled && !auth.verifyRequest(req)) return sendJson(res, 401, { error: "unauthorized" });
        return sendJson(res, 201, auth.mintEnrollToken());
      }
      return sendJson(res, 404, { error: "not found" });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.error("auth error", e);
      return sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ---- auth gate: every other /api route requires a valid session ----
  if (auth.enabled && path.startsWith("/api/")) {
    if (method !== "GET" && method !== "HEAD") {
      // Cheap CSRF defense-in-depth: a present Origin must match the host.
      const origin = req.headers.origin;
      if (origin) {
        let bad = true;
        try {
          bad = new URL(origin).host !== (req.headers.host ?? "");
        } catch {
          /* unparseable origin → refuse */
        }
        if (bad) return sendJson(res, 403, { error: "cross-origin request refused" });
      }
    }
    if (!auth.verifyRequest(req)) return sendJson(res, 401, { error: "unauthorized" });
  }

  // SSE
  if (method === "GET" && path === "/api/stream") {
    handleStream(req, res, url);
    return;
  }

  // REST
  try {
    if (path === "/api/push/key" && method === "GET") {
      return sendJson(res, 200, { publicKey: push.getPublicKey() });
    }
    if (path === "/api/push/subscribe" && method === "POST") {
      const body = await readBody(req);
      push.subscribe(body.subscription as PushSubscriptionJson);
      return sendJson(res, 201, { ok: true });
    }
    if (path === "/api/push/unsubscribe" && method === "POST") {
      const body = await readBody(req);
      push.unsubscribe(String(body.endpoint ?? ""));
      return sendJson(res, 200, { ok: true });
    }
    // Repo picker (read-only): discovery scan, drill-down listing, path pre-check.
    if (path === "/api/repos/discover" && method === "GET") {
      const out = discoverRepos(config.repoRoots, url.searchParams.get("refresh") === "1");
      return sendJson(res, 200, {
        repos: annotate(out.repos, service.listRepos()),
        roots: config.repoRoots,
        scannedAt: out.scannedAt,
      });
    }
    if (path === "/api/repos/validate" && method === "GET") {
      return sendJson(
        res, 200,
        validateRepoPath(url.searchParams.get("path") ?? "", config.repoRoots, service.listRepos()),
      );
    }
    if (path === "/api/fs/list" && method === "GET") {
      const target = url.searchParams.get("path") || defaultBrowseRoot(config.repoRoots);
      return sendJson(res, 200, listDirectory(target, config.repoRoots));
    }
    if (path === "/api/repos") {
      if (method === "GET") return sendJson(res, 200, { repos: service.listRepos() });
      if (method === "POST") return sendJson(res, 201, { repo: service.createRepo((await readBody(req)) as never) });
    }
    const repoM = /^\/api\/repos\/([^/]+)$/.exec(path);
    if (repoM && method === "DELETE") {
      return sendJson(res, 200, { repo: service.deleteRepo(decodeURIComponent(repoM[1])) });
    }
    if (path === "/api/usage" && method === "GET") {
      return sendJson(res, 200, { usage: service.usage() });
    }
    if (path === "/api/tasks") {
      if (method === "GET") {
        const status = (url.searchParams.get("status") ?? undefined) as TaskStatus | undefined;
        return sendJson(res, 200, { tasks: service.listTasks(status) });
      }
      if (method === "POST") return sendJson(res, 201, { task: service.createTask((await readBody(req)) as never) });
    }
    if (path === "/api/routines") {
      if (method === "GET") return sendJson(res, 200, { routines: routines.list() });
      if (method === "POST") return sendJson(res, 201, { routine: routines.create((await readBody(req)) as never) });
    }
    const rm = ROUTINE_ROUTE.exec(path);
    if (rm) {
      const id = decodeURIComponent(rm[1]);
      if (rm[2] === "run" && method === "POST") return sendJson(res, 200, { routine: routines.runNow(id) });
      if (rm[2] === "runs" && method === "GET") return sendJson(res, 200, { runs: routines.runs(id) });
      if (!rm[2]) {
        if (method === "GET") return sendJson(res, 200, { routine: routines.get(id) });
        if (method === "PATCH") return sendJson(res, 200, { routine: routines.update(id, (await readBody(req)) as never) });
        if (method === "DELETE") return sendJson(res, 200, { routine: routines.remove(id) });
      }
    }
    const m = TASK_ROUTE.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const action = m[2];
      if (!action) {
        if (method === "GET") return sendJson(res, 200, { task: service.getTask(id) });
        if (method === "DELETE") return sendJson(res, 200, { task: service.archive(id) });
      } else if (method === "POST") {
        const body = await readBody(req);
        switch (action) {
          case "followup":
            return sendJson(res, 202, {
              task: service.followup(id, String(body.prompt ?? ""), body.images, optStr(body.model), optStr(body.effort), optStr(body.permission)),
            });
          case "steer":
            return sendJson(res, 200, service.steer(id, String(body.text ?? ""), body.images, optStr(body.model), optStr(body.effort), optStr(body.permission)));
          case "approve":
            return sendJson(res, 200, {
              task: service.approve(id, String(body.decision ?? ""), body.scope as string | undefined),
            });
          case "answer":
            return sendJson(res, 200, { task: service.answer(id, body as never) });
          case "stop":
            return sendJson(res, 200, { task: service.stop(id) });
          case "cancel":
            return sendJson(res, 200, { task: service.cancel(id) });
        }
      }
    }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error("server error", e);
    sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(config.port, config.host, () => {
  console.log(
    `${BRANDING.productName} internal listener on ${config.host}:${config.port}  ·  TLS required at the public edge  ·  db=${config.dbPath}  ·  cap=${config.concurrency}`,
  );
});
