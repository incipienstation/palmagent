import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getRequestListener } from "@hono/node-server";
import { AuthService } from "../src/auth.js";
import { config } from "../src/config.js";
import { Db } from "../src/db.js";
import { Hub } from "../src/hub.js";
import { InProcessBackend } from "../src/inproc-backend.js";
import { PushService } from "../src/push.js";
import { RoutineService } from "../src/routines.js";
import { TaskService } from "../src/service.js";
import { ProcessSupervisor } from "../src/supervisor.js";
import { WorktreeManager } from "../src/worktree.js";
import { createApp, MAX_BODY_BYTES } from "../src/http/app.js";
import { startSessionControl, sessionSocket } from "../src/session-control.js";

function fixture(t: test.TestContext, authEnabled = true) {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-http-"));
  const db = new Db(join(dir, "state/palmagent.db"));
  const hub = new Hub();
  const service = new TaskService(db, hub, new ProcessSupervisor(1), new InProcessBackend(), new WorktreeManager());
  const settings = { ...config, authEnabled, rpId: "localhost", authOrigin: "https://localhost", repoRoots: [dir], staticDir: join(dir, "web") };
  const auth = new AuthService(db, settings);
  const shutdown = new AbortController();
  const app = createApp({ db, hub, service, auth, config: settings, shutdown: shutdown.signal,
    push: new PushService(db, join(dir, "vapid.json"), undefined), routines: new RoutineService(db, service) });
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => {
    shutdown.abort();
    try { for (const dispose of cleanup.reverse()) await dispose(); }
    finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  const closeListener = (server: ReturnType<typeof createServer>) => cleanup.push(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { dir, db, hub, service, auth, settings, shutdown, app, closeListener };
}

// Use the real Node adapter: cookies, streamed bodies and HEAD can differ from
// app.request even when route-level unit tests pass.
test("HTTP auth gates and input failures preserve cookies, status codes and mutation boundaries", async (t) => {
  const f = fixture(t);
  const server = createServer(getRequestListener(f.app.fetch));
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  f.closeListener(server);
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://localhost:${address.port}`;
  const now = Date.now();
  f.db.createSession("fixture-session", now, now + 60_000);
  f.db.createSession("expired-session", now - 1000, now - 1);
  const headers = { cookie: `${f.settings.cookieName}=fixture-session`, "content-type": "application/json" };
  assert.equal((await fetch(base + "/api/health")).status, 200);
  for (const path of ["/api/tasks", "/api/compatibility", "/api/stream", "/api/unknown"]) {
    assert.equal((await fetch(base + path)).status, 401);
  }
  assert.equal((await fetch(base + "/api/auth/enroll-token", { method: "POST" })).status, 401);
  for (const cookie of [`${f.settings.cookieName}=expired-session`, `${f.settings.cookieName}=%ZZ`]) {
    assert.equal((await fetch(base + "/api/tasks", { headers: { cookie } })).status, 401);
  }
  assert.equal((await fetch(base + "/api/tasks", { headers })).status, 200);
  assert.equal((await fetch(base + "/api/tasks/", { headers })).status, 404);
  assert.equal((await fetch(base + "/api/stream", { method: "HEAD", headers })).status, 404);
  assert.equal((await fetch(base + "/api/tasks/%ZZ", { headers })).status, 400);
  assert.equal((await fetch(base + "/api/tasks?status=invalid", { headers })).status, 400);
  assert.equal((await fetch(base + "/api/repos", { method: "POST", headers: { ...headers, origin: "https://other.example" }, body: "{}" })).status, 403);
  for (const body of ["{", "null", "[]", '{"path":12}', '{"path":"/fixture","name":false}']) {
    assert.equal((await fetch(base + "/api/repos", { method: "POST", headers, body })).status, 400);
  }
  assert.equal(f.service.listRepos().length, 0);
  const tooLarge = await f.app.request("/api/repos", { method: "POST", headers: { ...headers, "content-length": String(MAX_BODY_BYTES + 1) }, body: "{}" });
  assert.equal(tooLarge.status, 413);
  const options = await fetch(base + "/api/auth/login/options", { method: "POST" });
  assert.equal(options.status, 200);
  assert.match(options.headers.get("set-cookie")!, /wa_chal=.*HttpOnly.*Secure.*SameSite=Lax/i);
  const logout = await fetch(base + "/api/auth/logout", { method: "POST", headers });
  assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/i);
  assert.equal((await fetch(base + "/api/tasks", { headers })).status, 401);
});

test("SSE joins paginated replay to live output exactly once and releases slow or disconnected clients", async (t) => {
  const f = fixture(t, false);
  f.db.insertRepo({ id: "r", name: "fixture", path: f.dir, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  f.db.insertTask({ taskId: "t", repoId: "r", agent: "codex", prompt: "fixture", permission: "read-only", status: "idle", interrupted: false, createdAt: 1, updatedAt: 1, lastActivityAt: 1 });
  for (let i = 0; i < 5001; i++) f.db.insertEvent("t", "assistant_text", { text: String(i) }, i + 1);
  await f.service.init();
  let subscribers = 0;
  const subscribe = f.hub.onEvent.bind(f.hub);
  f.hub.onEvent = (callback) => { subscribers++; const off = subscribe(callback); return () => { subscribers--; off(); }; };
  for (const scoped of [false, true]) {
    const response = await f.app.request(`/api/stream${scoped ? "?task=t" : ""}`, { headers: { "Last-Event-ID": "1" } });
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
    const reader = response.body!.getReader();
    let buffer = new TextDecoder().decode((await reader.read()).value);
    assert.match(buffer, /"type":"tasks"/);
    const row = f.db.insertEvent("t", "assistant_text", { text: "live" }, Date.now());
    f.hub.emitEvent(f.db.eventsAfterGlobal(row.id - 1, 1)[0]);
    const target = scoped ? row.seq : row.id;
    const ids: number[] = [];
    while (ids.at(-1) !== target) {
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const match = /^id: (\d+)$/m.exec(frame);
        if (match) ids.push(Number(match[1]));
      }
      if (ids.at(-1) === target) break;
      const next = await reader.read(); assert.equal(next.done, false);
      buffer += new TextDecoder().decode(next.value);
    }
    assert.deepEqual(ids, Array.from({ length: target - 1 }, (_, i) => i + 2));
    await reader.cancel();
    assert.equal(subscribers, 0);
  }
  const slow = await f.app.request("/api/stream");
  for (let i = 0; i < 1030; i++) f.hub.emitTasks([]);
  assert.equal(subscribers, 0, "overflow disconnects instead of retaining unbounded output");
  await slow.body!.cancel();
  const remaining = await f.app.request("/api/stream");
  f.shutdown.abort();
  assert.equal(subscribers, 0, "shutdown releases subscriptions");
  await remaining.body!.cancel();
});

test("PWA serving preserves shell and asset caching and rejects paths outside the static root", async (t) => {
  const f = fixture(t, false);
  mkdirSync(join(f.dir, "web/assets"), { recursive: true });
  writeFileSync(join(f.dir, "web/index.html"), "<html>fixture</html>");
  writeFileSync(join(f.dir, "web/sw.js"), "// fixture");
  writeFileSync(join(f.dir, "web/assets/app-hash.js"), "// asset");
  writeFileSync(join(f.dir, "private.txt"), "private fixture");
  symlinkSync(join(f.dir, "private.txt"), join(f.dir, "web/outside.txt"));
  const app = createApp({ db: f.db, hub: f.hub, service: f.service, auth: f.auth, config: f.settings,
    push: new PushService(f.db, join(f.dir, "vapid.json"), undefined), routines: new RoutineService(f.db, f.service) });
  for (const path of ["/", "/sw.js", "/deep/link", "/assets/missing.js"]) {
    const response = await app.request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-cache");
  }
  assert.equal((await app.request("/assets/app-hash.js")).headers.get("cache-control"), "public, max-age=31536000, immutable");
  for (const path of ["/outside.txt", "/%2e%2e%2fprivate.txt", "/api/unknown"]) assert.equal((await app.request(path)).status, 404);
});

test("private dispatch bounds chunked UTF-8 bytes and rejects malformed input before the service", async (t) => {
  const f = fixture(t, false);
  const server = await startSessionControl(join(f.dir, "state"), f.service);
  f.closeListener(server);
  const send = (path: string, body: string) => new Promise<number>((resolve, reject) => {
    const req = request({ socketPath: sessionSocket(join(f.dir, "state")), method: "POST", path, headers: { "transfer-encoding": "chunked" } }, (res) => {
      res.resume(); res.once("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject); req.end(body);
  });
  assert.equal(await send("/dispatch", "{"), 400);
  assert.equal(await send("/dispatch", "[]"), 400);
  assert.equal(await send("/dispatch", '{"waitPid":"1"}'), 400);
  assert.equal(await send("/dispatch", JSON.stringify({ text: "한".repeat(6000) })), 413);
  assert.equal(await send("/api/tasks", "{}"), 404);
  assert.equal(f.service.listTasks().length, 0);
  assert.equal((await f.app.request("/dispatch", { method: "POST" })).status, 404);
});
