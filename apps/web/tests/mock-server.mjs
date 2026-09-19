// Self-contained mock backend for the Playwright harness. It serves the built PWA as
// static files AND answers /api over the exact same wire contract as the real
// dispatcher (REST + SSE), driven entirely by deterministic fixtures. No real
// backend, no claude/codex CLI, no SQLite — so a run is hermetic and repeatable.
//
//   node tests/mock-server.mjs            # serve on $PORT (default 4317)
//
// SSE frame format is copied verbatim from apps/server/src/server.ts:
//   ": connected\n\n"                                  on connect
//   "data: {"type":"tasks",...}\n\n"                   inbox snapshot (no id)
//   "id: <seq>\ndata: {"type":"event",...}\n\n"        scoped per-task event
// Frames are unnamed (default "message") so EventSource.onmessage receives them.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { repos, tasks, events, usage, routines, routineRuns, updateSettings } from "./fixtures.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DIST = process.env.E2E_DIST ?? join(__dirname, "..", "dist");
const PORT = Number(process.env.PORT ?? 4317);
// The standalone service-worker test simulates an available package and a slow
// install response. It never contacts an updater or an actual agent process.
if (process.env.PWA_UPDATE_TARGET) {
  updateSettings.settings.discovery.targetVersion = process.env.PWA_UPDATE_TARGET;
  events["t-run"] = Array.from({ length: 440 }, (_, index) => index % 2
    ? { kind: "tool_result", payload: { output: `Transition tool ${index + 1}` } }
    : { kind: "assistant_text", payload: { text: `Transition message ${index + 1}\n\n${"Conversation paragraph. ".repeat(8)}` } });
}

if (!existsSync(join(DIST, "index.html"))) {
  console.error(`[mock-server] no build at ${DIST}. Run \`pnpm --filter @palmagent/web build\` first (the test:e2e script does this).`);
  process.exit(1);
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const fsListings = new Map([
  [
    "/projects",
    {
      path: "/projects",
      parent: "/",
      entries: [
        {
          name: "outer-repo",
          path: "/projects/outer-repo",
          isGitRepo: true,
        },
      ],
    },
  ],
  [
    "/projects/outer-repo",
    {
      path: "/projects/outer-repo",
      parent: "/projects",
      root: "/projects/outer-repo",
      entries: [
        {
          name: "packages",
          path: "/projects/outer-repo/packages",
          isGitRepo: false,
        },
        {
          name: "nested-tools",
          path: "/projects/outer-repo/nested-tools",
          isGitRepo: true,
        },
      ],
    },
  ],
  [
    "/projects/outer-repo/nested-tools",
    {
      path: "/projects/outer-repo/nested-tools",
      parent: "/projects/outer-repo",
      root: "/projects/outer-repo/nested-tools",
      entries: [],
    },
  ],
]);

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
  res.end(buf);
}

// ----------------------------------------------------------------- SSE
function openSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
}
const tasksFrame = (res, replayThrough, history) => res.write(`data: ${JSON.stringify({ type: "tasks", tasks, replayThrough, history })}\n\n`);

const taskClients = new Set();

function handleStream(req, res, url) {
  const taskId = url.searchParams.get("task") || undefined;
  if (taskId && !tasks.some((t) => t.taskId === taskId)) {
    return json(res, 404, { error: `no such task: ${taskId}` });
  }
  openSse(res);
  taskClients.add(res);
  const stream = events[taskId] ?? [];
  const cursor = Number(req.headers["last-event-id"] ?? url.searchParams.get("lastEventId") ?? 0);
  const tail = taskId && url.searchParams.has("tail") && !url.searchParams.has("lastEventId") && !req.headers["last-event-id"];
  let after = tail ? Math.max(0, stream.length - 200) : cursor;
  while (tail && after > 0 && stream[after]?.kind === "assistant_text" && stream[after - 1]?.kind === "assistant_text") after--;
  if (tail) res.write(`id: ${after}\n`);
  tasksFrame(res, taskId ? stream.length : undefined, tail ? {
    after, before: after > 0 ? after + 1 : null,
  } : undefined);

  if (taskId) {
    // Replay the whole scoped stream immediately, stamping the per-task seq on
    // the `id:` line in fixture order. Sending synchronously keeps the rendered
    // log deterministic for snapshots (no inter-event timing to settle).
    stream.forEach((ev, i) => {
      if (i < after) return;
      const event = { taskId, agent: tasks.find((t) => t.taskId === taskId).agent, ts: 0, ...ev };
      res.write(`id: ${i + 1}\ndata: ${JSON.stringify({ type: "event", event })}\n\n`);
    });
  }

  const keepAlive = setInterval(() => {
    try {
      res.write(":keep-alive\n\n");
    } catch {
      /* socket gone */
    }
  }, 15_000);
  const close = () => { clearInterval(keepAlive); taskClients.delete(res); };
  req.on("close", close);
  res.on("close", close);
}

// ----------------------------------------------------------------- static
async function serveStatic(res, pathname) {
  // Hash routing means app routes arrive as "/" — everything non-/api that
  // isn't a real file falls back to the SPA shell.
  let rel = pathname === "/" ? "/index.html" : pathname;
  let filePath = normalize(join(DIST, rel));
  if (!filePath.startsWith(DIST)) return json(res, 403, { error: "forbidden" });
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) throw new Error("dir");
  } catch {
    filePath = join(DIST, "index.html"); // SPA fallback
  }
  try {
    const buf = await readFile(filePath);
    const type = MIME[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(buf);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

// ----------------------------------------------------------------- router
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;
  const m = req.method ?? "GET";

  if (pathname === "/api/stream") return handleStream(req, res, url);

  if (pathname.startsWith("/api/")) {
    // ---- GET reads ----
    if (m === "GET") {
      if (pathname === "/api/auth/me")
        return json(res, 200, { authenticated: true, required: false, credentialCount: 1 });
      if (pathname === "/api/health") return json(res, 200, { ok: true, runId: process.env.E2E_RUN_ID });
      if (pathname === "/api/settings/updates") return json(res, 200, updateSettings);
      if (pathname === "/api/settings/repos") return json(res, 200, {
        repoRoots: ["/projects"], defaults: ["/projects"], source: "installation", writable: true,
      });
      if (pathname === "/api/repos") return json(res, 200, { repos });
      if (pathname === "/api/repos/discover")
        return json(res, 200, { repos: [], roots: ["/projects"], scannedAt: 0 });
      if (pathname === "/api/repos/validate") {
        const input = url.searchParams.get("path") ?? "";
        const isGit = input === "/projects/outer-repo" || input === "/projects/outer-repo/nested-tools";
        return json(res, 200, {
          input,
          resolved: input,
          exists: isGit,
          isDir: isGit,
          isGit,
          ...(isGit ? { root: input, branch: "main" } : {}),
          suggestions: [],
        });
      }
      if (pathname === "/api/fs/list") {
        const target = url.searchParams.get("path") ?? "/projects";
        return json(res, 200, fsListings.get(target) ?? { path: target, entries: [] });
      }
      if (pathname === "/api/tasks") {
        const status = url.searchParams.get("status");
        return json(res, 200, { tasks: status ? tasks.filter((t) => t.status === status) : tasks });
      }
      const historyMatch = /^\/api\/tasks\/([^/]+)\/history$/.exec(pathname);
      if (historyMatch) {
        const id = decodeURIComponent(historyMatch[1]);
        const stream = events[id] ?? [];
        const before = Number(url.searchParams.get("before"));
        let start = Math.max(0, Math.min(stream.length, before - 1) - 200);
        while (start > 0 && stream[start]?.kind === "assistant_text" && stream[start - 1]?.kind === "assistant_text") start--;
        const agent = tasks.find((task) => task.taskId === id)?.agent ?? "codex";
        return json(res, 200, { events: stream.slice(start, before - 1).map((event, i) => ({
          seq: start + i + 1, event: { taskId: id, agent, ts: 0, ...event },
        })), before: start > 0 ? start + 1 : null });
      }
      if (pathname.startsWith("/api/tasks/")) {
        if (pathname.endsWith("/account-limits")) {
          const id = decodeURIComponent(pathname.slice("/api/tasks/".length, -"/account-limits".length));
          const task = tasks.find((t) => t.taskId === id);
          if (!task) return json(res, 404, { error: "no such task" });
          const window = { usedPercent: 28, resetsAt: Date.now() + 100 * 60_000 };
          return json(res, 200, task.agent === "claude"
            ? { agent: "claude", state: "ready", checkedAt: Date.now(), fiveHour: window, modelLimits: [] }
            : { agent: "codex", state: "ready", checkedAt: Date.now(), buckets: [{ id: "codex", name: "Codex", primary: { ...window, windowMinutes: 300 } }] });
        }
        const id = decodeURIComponent(pathname.slice("/api/tasks/".length));
        const task = tasks.find((t) => t.taskId === id);
        return task ? json(res, 200, { task }) : json(res, 404, { error: "no such task" });
      }
      if (pathname === "/api/usage") return json(res, 200, { usage });
      if (pathname === "/api/routines") return json(res, 200, { routines });
      {
        const rm = /^\/api\/routines\/([^/]+)\/runs$/.exec(pathname);
        if (rm) return json(res, 200, { runs: routineRuns[decodeURIComponent(rm[1])] ?? [] });
      }
      if (pathname === "/api/push/key") return json(res, 200, { publicKey: "BMOCK-vapid-public-key" });
      return json(res, 404, { error: `unmocked GET ${pathname}` });
    }
    // ---- writes: echo back a plausible task/result so the UI can proceed ----
    if (m === "POST" && pathname === "/api/settings/updates" && process.env.PWA_UPDATE_TARGET) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const action = JSON.parse(body);
      if (action.action === "install") {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        updateSettings.settings.pending = { id: "mock-install", channel: "preview",
          currentVersion: updateSettings.currentVersion, targetVersion: action.version, automatic: false };
      }
      return json(res, 200, updateSettings);
    }
    if (m === "PATCH" && pathname.startsWith("/api/tasks/")) {
      const task = tasks.find((t) => t.taskId === decodeURIComponent(pathname.slice("/api/tasks/".length)));
      if (!task) return json(res, 404, { error: "no such task" });
      let input;
      try {
        let body = "";
        for await (const chunk of req) body += chunk;
        input = JSON.parse(body);
      } catch { return json(res, 400, { error: "invalid JSON" }); }
      const title = typeof input?.title === "string" ? input.title.trim() : "";
      if (!title || title.length > 200 || /[\r\n]/.test(title)) return json(res, 400, { error: "invalid title" });
      task.title = title;
      for (const client of taskClients) tasksFrame(client);
      return json(res, 200, { task });
    }
    const first = tasks[0];
    if (m === "POST" && pathname === "/api/tasks") return json(res, 200, { task: first });
    if (pathname.endsWith("/steer")) return json(res, 200, { injected: true, queued: false });
    if (pathname.endsWith("/followup") || pathname.endsWith("/approve")) return json(res, 200, { task: first });
    if (pathname.endsWith("/answer")) {
      // The answered task resumes running with its pending question cleared.
      const id = decodeURIComponent(pathname.slice("/api/tasks/".length, -"/answer".length));
      const t = tasks.find((x) => x.taskId === id) ?? first;
      return json(res, 200, { task: { ...t, status: "running", pendingInput: undefined } });
    }
    if (pathname.endsWith("/stop") || pathname.endsWith("/cancel")) return json(res, 200, { task: first });
    if (m === "DELETE" && pathname.startsWith("/api/tasks/")) return json(res, 200, { task: first });
    if (pathname.startsWith("/api/push")) return json(res, 200, { ok: true });
    if (pathname.startsWith("/api/auth")) return json(res, 200, { ok: true });
    return json(res, 200, { ok: true });
  }

  return void serveStatic(res, pathname);
});

server.listen(PORT, "localhost", () => {
  const port = server.address().port;
  console.log(`[mock-server] internal listener on localhost:${port} (dist: ${DIST})`);
  process.send?.({ url: `http://localhost:${port}`, runId: process.env.E2E_RUN_ID });
});
// The runner owns this process, including when it is interrupted before cleanup.
if (process.send) process.on("disconnect", () => process.exit(0));
