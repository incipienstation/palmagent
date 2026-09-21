import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getRequestListener } from "@hono/node-server";
import { AuthService } from "../src/auth.js";
import { AccountLimitReader } from "../src/account-limits.js";
import { nativeHome } from "../src/native-session.js";
import { config } from "../src/config.js";
import { Db } from "../src/db.js";
import { Hub } from "../src/hub.js";
import { InProcessBackend } from "../src/inproc-backend.js";
import { PushService } from "../src/push.js";
import { RoutineService } from "../src/routines.js";
import { TaskService } from "../src/service.js";
import { ProcessSupervisor } from "../src/supervisor.js";
import { WorktreeManager } from "../src/worktree.js";
import { createApp, MAX_BODY_BYTES, MAX_IMAGE_BODY_BYTES } from "../src/http/app.js";
import { SettingsStore } from "../src/settings.js";
import { startSessionControl, sessionSocket } from "../src/session-control.js";
import type { HttpDependencies } from "../src/http/types.js";
import type { UpdateSettingsState, UpdateSettingsStatus } from "@palmagent/shared";

function fixture(t: test.TestContext, authEnabled = true, extra: Pick<HttpDependencies, "updates" | "build"> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-http-"));
  const db = new Db(join(dir, "state/palmagent.db"));
  const hub = new Hub();
  const service = new TaskService(db, hub, new ProcessSupervisor(1), new InProcessBackend(), new WorktreeManager());
  const settings = { ...config, authEnabled, rpId: "localhost", authOrigin: "https://localhost", repoRoots: [dir], staticDir: join(dir, "web") };
  const auth = new AuthService(db, settings);
  const shutdown = new AbortController();
  const repoSettings = new SettingsStore(join(dir, "state"), settings.repoRoots);
  const app = createApp({ db, hub, service, auth, config: settings, settings: repoSettings, shutdown: shutdown.signal,
    push: new PushService(db, join(dir, "vapid.json"), undefined), routines: new RoutineService(db, service), ...extra });
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
  return { dir, db, hub, service, auth, settings, repoSettings, shutdown, app, closeListener };
}

test("voice routes require authentication, reject non-Codex contexts and resolve the native home server-side", async t => {
  const f = fixture(t);
  const repo = f.service.createRepo({ path: f.dir });
  const id = "11111111-1111-4111-8111-111111111111";
  const calls: string[] = [];
  f.service.voice.start = async (home, sdp) => { calls.push(home); assert.equal(sdp, "v=0\r\noffer"); return { id, sdp: "v=0\r\nanswer" }; };
  const now = Date.now(); f.db.createSession("voice-session", now, now + 60_000);
  const headers = { cookie: `${f.settings.cookieName}=voice-session`, "content-type": "application/json" };
  const payload = (agent: string) => JSON.stringify({ context: { repoId: repo.id, agent }, sdp: "v=0\r\noffer" });
  assert.equal((await f.app.request("/api/voice", { method: "POST", body: payload("codex") })).status, 401);
  assert.equal((await f.app.request("/api/voice", { method: "POST", headers, body: payload("claude") })).status, 400);
  const result = await f.app.request("/api/voice", { method: "POST", headers, body: payload("codex") });
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { id, sdp: "v=0\r\nanswer" });
  assert.deepEqual(calls, [nativeHome("codex")]);
  assert.equal((await f.app.request(`/api/voice/${id}/heartbeat`, { method: "POST", headers })).status, 410);
  assert.equal((await f.app.request(`/api/voice/${id}`, { method: "DELETE", headers })).status, 200);
  assert.equal((await f.app.request("/api/voice/not-an-id", { method: "DELETE", headers })).status, 400);
});

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
  for (const path of ["/api/tasks", "/api/tasks/t/history?before=2", "/api/tasks/fixture/account-limits", "/api/compatibility", "/api/terminals", "/api/stream", "/api/unknown"]) {
    const denied = await fetch(base + path);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("cache-control"), "no-store");
  }
  assert.equal((await fetch(base + "/api/auth/enroll-token", { method: "POST" })).status, 401);
  for (const cookie of [`${f.settings.cookieName}=expired-session`, `${f.settings.cookieName}=%ZZ`]) {
    assert.equal((await fetch(base + "/api/tasks", { headers: { cookie } })).status, 401);
  }
  const list = await fetch(base + "/api/tasks", { headers });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(base + "/api/tasks/missing/account-limits", { headers })).status, 404);
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
  const sendChunked = (path: string, body: string, method = "POST") => new Promise<number>((resolve, reject) => {
    const req = request(base + path, { method, headers: { ...headers, "transfer-encoding": "chunked" } }, (res) => {
      res.resume(); res.once("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject); req.end(body);
  });
  const oversized = JSON.stringify({ text: "한".repeat(Math.ceil(MAX_BODY_BYTES / 3)) });
  for (const [path, method] of [["/api/auth/login/verify", "POST"], ["/api/settings/updates", "PATCH"], ["/api/tasks/t", "PATCH"]]) {
    assert.equal(await sendChunked(path, oversized, method), 413, path);
  }
  for (const path of ["/api/tasks", "/api/tasks/t/messages", "/api/tasks/t/messages/m", "/api/tasks/t/followup", "/api/tasks/t/steer"]) {
    // Larger image envelopes reach validation; an invalid body cannot mutate state.
    assert.equal(await sendChunked(path, "{}".padEnd(MAX_BODY_BYTES + 1)), 400, path);
    assert.equal((await f.app.request(path, { method: "POST", headers: { ...headers, "content-length": String(MAX_IMAGE_BODY_BYTES + 1) }, body: "{}" })).status, 413, path);
  }
  assert.equal(await sendChunked("/api/auth/login/options", "{}".padEnd(MAX_BODY_BYTES)), 200);
  assert.equal(await sendChunked("/api/auth/login/options", "{}".padEnd(MAX_BODY_BYTES + 1)), 413);
  assert.equal(await sendChunked("/api/tasks/t/stop", oversized), 413);
  assert.equal(f.service.listTasks().length, 0);
  const options = await fetch(base + "/api/auth/login/options", { method: "POST" });
  assert.equal(options.status, 200);
  assert.equal(options.headers.get("cache-control"), "no-store");
  assert.match(options.headers.get("set-cookie")!, /wa_chal=.*HttpOnly.*Secure.*SameSite=Lax/i);
  const logout = await fetch(base + "/api/auth/logout", { method: "POST", headers });
  assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/i);
  assert.equal((await fetch(base + "/api/tasks", { headers })).status, 401);
});

test("update settings require authentication, validate one bounded preference, and report the running build", async (t) => {
  let changes = 0;
  const state: UpdateSettingsState = { availability: "available", settings: {
    channel: "stable", autoUpdate: false, discovery: null, pending: null, lastUpdate: null,
  } };
  const updates = {
    async status() { return state; },
    async action() { changes++; return state; },
    async resume() { return state; },
    async change(change: import("@palmagent/shared").UpdateSettingsChange) {
      changes++;
      Object.assign(state.settings!, change);
      return state;
    },
  };
  const f = fixture(t, true, { updates, build: { version: "0.1.0-alpha.4", sourceCommit: "fixture", dirty: false } });
  const path = "/api/settings/updates";
  const now = Date.now();
  f.db.createSession("settings-session", now, now + 60_000);
  const headers = { cookie: `${f.settings.cookieName}=settings-session`, "content-type": "application/json" };
  assert.equal((await f.app.request(path)).status, 401);
  assert.equal((await f.app.request(path, { method: "PATCH", body: '{"autoUpdate":true}' })).status, 401);
  const initial = await f.app.request(path, { headers });
  assert.equal(initial.headers.get("cache-control"), "no-store");
  assert.deepEqual(await initial.json(), { ...state, currentVersion: "0.1.0-alpha.4" });
  for (const input of ["{", "null", "[]", "{}", '{"autoUpdate":"true"}', '{"channel":"next"}',
    '{"autoUpdate":true,"channel":"preview"}', '{"autoUpdate":true,"command":"install"}', '{"dataDir":"/other"}']) {
    assert.equal((await f.app.request(path, { method: "PATCH", headers, body: input })).status, 400, input);
  }
  assert.equal((await f.app.request(path, { method: "PATCH", headers: { ...headers, origin: "https://other.example" }, body: '{"autoUpdate":true}' })).status, 403);
  assert.equal(changes, 0);
  for (const change of [{ channel: "preview" }, { autoUpdate: true }]) {
    const result = await f.app.request(path, { method: "PATCH", headers, body: JSON.stringify(change) });
    assert.equal(result.status, 200);
    assert.equal((await result.json() as UpdateSettingsStatus).currentVersion, "0.1.0-alpha.4");
  }
  assert.equal(changes, 2);
  assert.equal(state.settings?.channel, "preview");
  assert.equal(state.settings?.autoUpdate, true);
  const dev = fixture(t, false, { updates });
  for (const method of ["PATCH", "POST"]) {
    assert.equal((await dev.app.request(path, { method, body: "{" })).status, 403, "admission precedes body parsing");
  }
  assert.equal((await (await dev.app.request(path)).json() as UpdateSettingsStatus).availability, "authentication-required");
  assert.equal((await dev.app.request(path, { method: "PATCH", body: '{"autoUpdate":false}' })).status, 403);
  assert.equal(changes, 2);
  assert.equal((await f.app.request(path, { method: "POST", body: '{"action":"visit"}' })).status, 401);
  assert.equal((await dev.app.request(path, { method: "POST", body: '{"action":"visit"}' })).status, 403);
  for (const input of [{ action: "resume" }, { action: "install" }, { action: "install", version: "1.0.0", command: "sh" }, { action: "visit", path: "/other" }]) {
    assert.equal((await f.app.request(path, { method: "POST", headers, body: JSON.stringify(input) })).status, 400);
  }
  assert.equal((await f.app.request(path, { method: "POST", headers: { ...headers, origin: "https://other.example" }, body: '{"action":"visit"}' })).status, 403);
  const old = await f.app.request(path, { method: "POST", headers: { ...headers, "x-palmagent-version": "0.1.0-alpha.3" }, body: '{"action":"visit"}' });
  assert.equal(old.status, 409);
  const oldError = await old.json();
  assert.ok(oldError && typeof oldError === "object" && "code" in oldError);
  assert.equal(oldError.code, "update-required");
  assert.equal(old.headers.get("x-palmagent-version"), "0.1.0-alpha.4");
  assert.equal(changes, 2, "old screens cannot change the new server");
  for (const input of [{ action: "visit" }, { action: "check" }, { action: "install", version: "0.1.0-alpha.5" }]) {
    assert.equal((await f.app.request(path, { method: "POST", headers: { ...headers, "x-palmagent-version": "0.1.0-alpha.4" }, body: JSON.stringify(input) })).status, 200);
  }
  assert.equal(changes, 5);
});

test("Space settings authenticate writes and share live discovery, browse, and reset with the CLI store", async (t) => {
  const f = fixture(t);
  const path = "/api/settings/repos";
  const now = Date.now();
  f.db.createSession("repo-settings-session", now, now + 60_000);
  const headers = { cookie: `${f.settings.cookieName}=repo-settings-session`, "content-type": "application/json" };
  const get = async (url: string) => {
    const response = await f.app.request(url, { headers });
    assert.equal(response.status, 200);
    return response.json() as Promise<any>;
  };
  const patch = (body: unknown) => f.app.request(path, { method: "PATCH", headers, body: JSON.stringify(body) });
  assert.equal((await f.app.request(path)).status, 401);
  assert.equal((await f.app.request(path, { method: "PATCH", body: '{"action":"reset"}' })).status, 401);
  assert.equal((await f.app.request(path, { headers })).headers.get("cache-control"), "no-store");
  assert.equal((await f.app.request(path, { method: "PATCH", headers: { ...headers, origin: "https://other.example" }, body: '{"action":"reset"}' })).status, 403);
  for (const body of [{}, { action: "reset", extra: true }, { action: "set", paths: "bad" },
    { action: "set", paths: ["relative"] }, { action: "set", paths: [join(f.dir, "missing")] }]) {
    assert.equal((await patch(body)).status, 400);
  }
  const root = join(f.dir, "search");
  const repo = join(root, "project");
  mkdirSync(join(repo, ".git"), { recursive: true });
  f.db.insertRepo({ id: "registered", name: "existing", path: f.dir, vcs: "none", defaultBaseRef: "", createdAt: now });
  assert.equal((await patch({ action: "set", paths: [root] })).status, 200);
  const cliStore = new SettingsStore(f.repoSettings.dataDir, f.settings.repoRoots);
  assert.deepEqual(cliStore.get().repoRoots, [root]);
  assert.deepEqual((await get("/api/repos/discover")).repos.map((r: { path: string }) => r.path), [repo]);
  assert.equal((await get("/api/fs/list")).path, root);
  cliStore.change({ action: "set", paths: [] });
  assert.deepEqual((await get(path)).repoRoots, []);
  assert.deepEqual((await get("/api/repos/discover")).repos, []);
  assert.equal((await get("/api/repos")).repos.length, 1, "registered spaces remain");
  assert.equal((await patch({ action: "reset" })).status, 200);
  assert.deepEqual(cliStore.get().repoRoots, [f.dir]);
  assert.equal((await get("/api/fs/list")).path, f.dir);
  const dev = fixture(t, false);
  assert.equal((await (await dev.app.request(path)).json() as { writable: boolean }).writable, false);
  assert.equal((await dev.app.request(path, { method: "PATCH", body: '{"action":"reset"}' })).status, 403);
});

test("account limits use the task's provider home without starting a turn and are not browser-cacheable", async (t) => {
  const f = fixture(t, false);
  const home = join(f.dir, "selected-account");
  f.db.insertRepo({ id: "r", name: "fixture", path: f.dir, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  for (const agent of ["claude", "codex"] as const) f.db.insertTask({ taskId: agent, repoId: "r", agent, prompt: "fixture", permission: "read-only", status: "idle", interrupted: false, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
    ...(agent === "codex" ? { sessionControl: { owner: "palmagent" as const, home, transcript: join(home, "session.jsonl"), cursor: 0, prefixHash: "fixture" } } : {}),
  });
  await f.service.init();
  const calls: unknown[] = [];
  t.mock.method(AccountLimitReader.prototype, "get", async (agent: "claude" | "codex", providerHome: string) => {
    calls.push([agent, providerHome]);
    return agent === "claude" ? { agent, state: "unavailable", checkedAt: 1, modelLimits: [] } : { agent, state: "ready", checkedAt: 1, buckets: [] };
  });
  for (const agent of ["claude", "codex"] as const) {
    const response = await f.app.request(`/api/tasks/${agent}/account-limits`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json() as { agent: string }).agent, agent);
    assert.equal(f.service.getTask(agent).status, "idle");
  }
  assert.deepEqual(calls, [["claude", nativeHome("claude")], ["codex", home]]);
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
    const snapshot = JSON.parse(buffer.split("data: ")[1].split("\n")[0]);
    assert.equal(snapshot.replayThrough, scoped ? f.db.eventCursor("t") : undefined);
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
  const app = createApp({ db: f.db, hub: f.hub, service: f.service, auth: f.auth, config: f.settings, settings: f.repoSettings,
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

test("session rename persists and broadcasts display metadata without changing execution or activity", async (t) => {
  const f = fixture(t);
  f.db.insertRepo({ id: "rename-repo", name: "fixture", path: f.dir, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  f.db.insertTask({ taskId: "rename-task", repoId: "rename-repo", agent: "codex", title: "Original", prompt: "Keep the prompt", permission: "read-only", status: "idle", interrupted: false, sessionId: "native-session", createdAt: 1, updatedAt: 2, lastActivityAt: 3 });
  await f.service.init();
  const now = Date.now();
  f.db.createSession("rename-session", now, now + 60_000);
  const headers = { cookie: `${f.settings.cookieName}=rename-session`, "content-type": "application/json" };
  const path = "/api/tasks/rename-task";
  const rename = (input: unknown, requestHeaders = headers) => f.app.request(path, { method: "PATCH", headers: requestHeaders, body: JSON.stringify(input) });
  assert.equal((await rename({ title: "Unauthorized" }, { ...headers, cookie: "" })).status, 401);
  assert.equal((await rename({ title: "Cross origin" }, { ...headers, origin: "https://other.example" } as typeof headers)).status, 403);
  for (const input of [{}, { title: null }, { title: 4 }, { title: "" }, { title: "   " }, { title: "x".repeat(201) }, { title: "two\nlines" }]) {
    assert.equal((await rename(input)).status, 400);
  }
  assert.equal(f.db.getTask("rename-task")!.title, "Original");
  assert.equal((await f.app.request("/api/tasks/missing", { method: "PATCH", headers, body: '{"title":"Valid"}' })).status, 404);

  const readers = await Promise.all(["/api/stream", "/api/stream?task=rename-task"].map(async (url) => {
    const response = await f.app.request(url, { headers });
    const reader = response.body!.getReader();
    t.after(() => reader.cancel());
    return reader;
  }));
  async function snapshot(reader: ReadableStreamDefaultReader<Uint8Array>) {
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      buffer += new TextDecoder().decode(chunk.value);
      for (const line of buffer.split("\n")) {
        if (line.startsWith("data: ")) {
          const frame = JSON.parse(line.slice(6));
          if (frame.type === "tasks") return frame.tasks;
        }
      }
    }
  }
  for (const reader of readers) await snapshot(reader);
  let broadcasts = 0;
  f.hub.onTasks(() => broadcasts++);
  for (const status of ["running", "awaiting_input", "idle", "archived"] as const) {
    const task = f.service.getTask("rename-task");
    task.status = status;
    f.db.setTaskStatus(task.taskId, status, false, task.updatedAt);
    if (status === "idle") {
      task.sessionControl = { owner: "local", home: f.dir, transcript: join(f.dir, "session.jsonl"), cursor: 0, prefixHash: "fixture" };
      f.db.setSessionControl(task.taskId, task.sessionControl);
    }
    const before = structuredClone(task);
    const result = await rename({ title: `  Renamed ${status} 한글  `, prompt: "must not change", status: "cancelled" });
    assert.equal(result.status, 200);
    const expected = { ...before, title: `Renamed ${status} 한글`, updatedAt: task.updatedAt };
    assert.deepEqual((await result.json() as { task: unknown }).task, JSON.parse(JSON.stringify(expected)));
    assert.deepEqual(f.db.getTask(task.taskId), expected);
    for (const reader of readers) assert.equal((await snapshot(reader))[0].title, expected.title);
  }
  assert.equal(broadcasts, 4);
  assert.equal(f.db.eventCursor("rename-task"), 0, "rename must not create a conversation event");
  const updatedAt = f.service.getTask("rename-task").updatedAt;
  await rename({ title: "Renamed archived 한글" });
  assert.equal(broadcasts, 4, "identical rename should be a no-op");
  assert.equal(f.service.getTask("rename-task").updatedAt, updatedAt);
  const reopened = new Db(join(f.dir, "state/palmagent.db"));
  try { assert.equal(reopened.getTask("rename-task")!.title, "Renamed archived 한글"); }
  finally { reopened.close(); }
});

test("recent history pages join live replay, and preserve whole messages", async (t) => {
  const f = fixture(t, false);
  f.db.insertRepo({ id: "r", name: "fixture", path: f.dir, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  f.db.insertTask({ taskId: "t", repoId: "r", agent: "codex", prompt: "fixture", permission: "read-only", status: "idle", interrupted: false, createdAt: 1, updatedAt: 1, lastActivityAt: 1 });
  f.db.insertEvent("t", "result", { usage: { input_tokens: 1234 } }, 1);
  for (let i = 2; i <= 1000; i++) f.db.insertEvent("t", "tool_result", { text: `row ${i}` }, i);
  await f.service.init();
  const response = await f.app.request("/api/stream?task=t&tail=1");
  const reader = response.body!.getReader();
  let buffer = new TextDecoder().decode((await reader.read()).value);
  const snapshot = JSON.parse(buffer.split("data: ")[1].split("\n")[0]);
  assert.match(buffer, /id: 800\n/);
  assert.equal(snapshot.history.after, 800);
  assert.equal(snapshot.history.before, 801);
  assert.equal(snapshot.replayThrough, 1000);
  const live = f.db.insertEvent("t", "tool_result", { text: "live" }, 1001);
  f.hub.emitEvent(f.db.eventsAfterSeq("t", 1000)[0]);
  while (!buffer.includes(`id: ${live.seq}\n`)) buffer += new TextDecoder().decode((await reader.read()).value);
  const ids = [...buffer.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  assert.deepEqual(ids, Array.from({ length: 202 }, (_, i) => i + 800));
  await reader.cancel();

  const collected: number[] = [];
  let before: number | null = 801;
  while (before !== null) {
    const pageResponse = await f.app.request(`/api/tasks/t/history?before=${before}`);
    assert.equal(pageResponse.headers.get("cache-control"), "no-store");
    const page = await pageResponse.json() as import("@palmagent/shared").TaskHistoryResponse;
    assert.ok(page.events.length <= 200);
    collected.unshift(...page.events.map((row) => row.seq));
    before = page.before;
  }
  assert.deepEqual(collected, Array.from({ length: 800 }, (_, i) => i + 1));
  assert.equal((await f.app.request("/api/tasks/missing/history?before=2")).status, 404);
  for (const value of ["", "0", "-1", "1.5", "NaN", "9007199254740992"]) {
    assert.equal((await f.app.request(`/api/tasks/t/history?before=${value}`)).status, 400);
  }
  // A page edge inside a Markdown fence moves back to the start of the run.
  for (let i = 0; i < 500; i++) f.db.insertEvent("t", "assistant_text", { text: i === 0 ? "```ts\n" : "content\n" }, 2000 + i);
  f.db.insertEvent("t", "assistant_text", { text: "```" }, 3000);
  const page = f.db.historyPage("t", f.db.eventCursor("t") + 1);
  assert.equal(page.events[0].seq, 1002);
  assert.equal(page.events.length, 501);
  assert.equal(page.before, 1002);

  // An explicit reconnect cursor must never be replaced by a fresh tail,
  // including zero (an initially empty session may have accumulated many rows).
  for (const cursor of [0, 500]) {
    const resumed = await f.app.request(`/api/stream?task=t&tail=1&lastEventId=${cursor}`);
    const reader = resumed.body!.getReader();
    let chunk = new TextDecoder().decode((await reader.read()).value);
    assert.ok(!chunk.includes('"history"'));
    while (!chunk.includes("id:")) chunk += new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, new RegExp(`id: ${cursor + 1}\\n`));
    await reader.cancel();
  }
});

test("snapshot-only inbox streams omit historical and live event bodies", async (t) => {
  const f = fixture(t, false);
  f.db.insertRepo({ id: "r", name: "fixture", path: f.dir, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  f.db.insertTask({ taskId: "t", repoId: "r", agent: "codex", prompt: "fixture", permission: "read-only", status: "idle", interrupted: false, createdAt: 1, updatedAt: 1, lastActivityAt: 1 });
  f.db.insertEvent("t", "assistant_text", { text: "unused history" }, 1);
  await f.service.init();
  const response = await f.app.request("/api/stream?snapshots=1");
  const reader = response.body!.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /"type":"tasks"/);
  f.hub.emitEvent({ id: 2, seq: 2, event: { taskId: "t", agent: "codex", ts: 1, kind: "assistant_text", payload: { text: "unused" } } });
  f.hub.emitTasks([]);
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /"type":"tasks"/);
  assert.ok(!next.includes('"type":"event"'));
  await reader.cancel();
});

test("task images require a session and serve only bounded raster files inside the task directory", async (t) => {
  const f = fixture(t);
  const cwd = join(f.dir, "task");
  mkdirSync(cwd);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  writeFileSync(join(cwd, "preview #1.png"), png);
  writeFileSync(join(f.dir, "outside.png"), png);
  writeFileSync(join(cwd, "pretend.png"), "<svg onload='alert(1)'></svg>");
  writeFileSync(join(cwd, "large.png"), Buffer.alloc(5 * 1024 * 1024 + 1));
  symlinkSync(join(f.dir, "outside.png"), join(cwd, "escape.png"));
  symlinkSync(f.dir, join(cwd, "outside-dir"));
  symlinkSync(join(cwd, "preview #1.png"), join(cwd, "inside.png"));
  f.db.insertRepo({ id: "r", name: "fixture", path: f.dir, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  f.db.insertTask({ taskId: "images", repoId: "r", agent: "codex", prompt: "fixture", worktreePath: cwd,
    permission: "read-only", status: "idle", interrupted: false, createdAt: 1, updatedAt: 1, lastActivityAt: 1 });
  await f.service.init();
  const now = Date.now();
  f.db.createSession("image-session", now, now + 60_000);
  const headers = { cookie: `${f.settings.cookieName}=image-session` };
  const url = (path: string) => `/api/tasks/images/image?${new URLSearchParams({ path })}`;
  assert.equal((await f.app.request(url("preview #1.png"))).status, 401);
  for (const path of ["preview #1.png", "inside.png", join(cwd, "preview #1.png")]) {
    const response = await f.app.request(url(path), { headers });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  }
  for (const path of ["../outside.png", join(f.dir, "outside.png"), "escape.png", "outside-dir/outside.png", "missing.png", ".", "https://example.invalid/image.png"]) {
    assert.equal((await f.app.request(url(path), { headers })).status, 404, path);
  }
  assert.equal((await f.app.request(url("pretend.png"), { headers })).status, 415);
  assert.equal((await f.app.request(url("large.png"), { headers })).status, 413);
  for (const query of ["", "?path=", "?path=%00", `?path=${"a".repeat(4097)}`]) {
    assert.equal((await f.app.request(`/api/tasks/images/image${query}`, { headers })).status, 400);
  }
  assert.equal((await f.app.request("/api/tasks/missing/image?path=preview.png", { headers })).status, 404);
  await f.app.request("/api/auth/logout", { method: "POST", headers });
  assert.equal((await f.app.request(url("preview #1.png"), { headers })).status, 401);
});


test("browser terminal access fails closed when sign-in is disabled", async (t) => {
  const f = fixture(t, false);
  for (const method of ["GET", "POST"]) {
    const response = await f.app.request("/api/terminals", { method });
    assert.equal(response.status, 403);
  }
});

test("skill discovery is authenticated and bound to the task's provider home and worktree", async t => {
  const f = fixture(t, false);
  const seen: unknown[] = [];
  f.service.skillDiscovery.list = async env => { seen.push(env); return { skills: [] }; };
  const now = Date.now();
  f.db.insertRepo({ id: "skills-repo", name: "Example", path: f.dir, vcs: "none", defaultBaseRef: "", createdAt: now });
  f.db.insertTask({ taskId: "skills-task", repoId: "skills-repo", agent: "codex", prompt: "Hello", status: "idle", interrupted: false,
    permission: "read-only", createdAt: now, updatedAt: now, lastActivityAt: now, worktreePath: join(f.dir, "worktree"),
    sessionControl: { owner: "palmagent", home: join(f.dir, "profile"), transcript: "", cursor: 0, prefixHash: "" } });
  await f.service.init();
  const res = await f.app.request("/api/skills?taskId=skills-task");
  assert.equal(res.status, 200); assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(seen, [{ agent: "codex", cwd: join(f.dir, "worktree"), home: join(f.dir, "profile") }]);
  assert.equal((await f.app.request("/api/skills?repoId=skills-repo&agent=claude")).status, 200);
  assert.equal((await f.app.request("/api/skills?taskId=missing")).status, 404);
  assert.equal((await f.app.request("/api/skills?taskId=skills-task&repoId=skills-repo")).status, 400);
  assert.equal((await f.app.request("/api/skills?cwd=/arbitrary")).status, 400);
  const secured = fixture(t);
  assert.equal((await secured.app.request("/api/skills?taskId=skills-task")).status, 401);
});

test("stopping or cancelling during skill revalidation never starts a provider", async t => {
  for (const action of ["stop", "cancel"] as const) {
    const f = fixture(t, false);
    f.db.insertRepo({ id: "skills-race", name: "Example", path: f.dir, vcs: "none", defaultBaseRef: "", createdAt: 1 });
    let reject!: (error: Error) => void;
    f.service.skillDiscovery.resolve = () => new Promise((_resolve, fail) => { reject = fail; });
    const task = f.service.createTask({ repoId: "skills-race", agent: "codex", prompt: "Check", skills: [{ id: "skill", name: "check", source: "repo" }] });
    assert.equal(task.status, "queued");
    f.service[action](task.taskId);
    reject(new Error("Skill was removed"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.service.getTask(task.taskId).status, action === "stop" ? "idle" : "cancelled");
  }
});

test("retrying an accepted skill message returns its receipt after plugin removal", async t => {
  const f = fixture(t, false);
  f.db.insertRepo({ id: "skill-retry", name: "Example", path: f.dir, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  f.db.insertTask({ taskId: "skill-retry-task", repoId: "skill-retry", agent: "codex", prompt: "Hello", status: "idle", interrupted: false,
    permission: "read-only", createdAt: 1, updatedAt: 1, lastActivityAt: 1, worktreePath: f.dir });
  await f.service.init(); f.service.messages.pause("skill-retry-task");
  const skill = { id: "selected", name: "check", source: "repo" };
  let discoveries = 0;
  f.service.skillDiscovery.resolve = async () => { if (++discoveries > 1) throw Error("Plugin removed"); return [skill]; };
  const request = { clientMessageId: "d882c3fc-d8c5-4df5-8f2b-3877de3d5823", mode: "queue", expectedRunId: null, text: "Check", skills: [skill] };
  const post = (body: unknown) => f.app.request("/api/tasks/skill-retry-task/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post(request)).status, 202);
  assert.equal((await post(request)).status, 202);
  assert.equal(discoveries, 1);
  assert.equal((await post({ ...request, text: "Different intent" })).status, 409);
  assert.equal((await post({ ...request, skills: [] })).status, 409);
});


test("stored attachments require authentication and task membership, survive archive, and disappear with the Space", async t => {
  const f = fixture(t);
  f.db.insertRepo({ id: "r", name: "fixture", path: f.dir, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  for (const taskId of ["stored", "other"]) f.db.insertTask({ taskId, repoId: "r", agent: "codex", prompt: "fixture", worktreePath: f.dir,
    permission: "read-only", status: "idle", interrupted: false, createdAt: 1, updatedAt: 1, lastActivityAt: 1 });
  await f.service.init();
  const image = { mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" };
  const [ref] = f.service.attachments.save("stored", [image])!;
  const path = `/api/tasks/stored/attachments/${ref.id}`;
  assert.equal((await f.app.request(path)).status, 401);
  f.db.createSession("attachment-session", Date.now(), Date.now() + 60_000);
  const headers = { cookie: `${f.settings.cookieName}=attachment-session` };
  const response = await f.app.request(path, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(image.data, "base64"));
  assert.equal((await f.app.request(`/api/tasks/other/attachments/${ref.id}`, { headers })).status, 404);
  assert.equal((await f.app.request("/api/tasks/stored/attachments/not-an-id", { headers })).status, 400);
  f.service.archive("stored"); f.service.archive("other");
  assert.equal((await f.app.request(path, { headers })).status, 200);
  f.service.deleteRepo("r");
  assert.equal((await f.app.request(path, { headers })).status, 404);
  assert.equal(f.db.attachmentIds().size, 0);
});


test("attachment storage failure rolls back task creation", async t => {
  const f = fixture(t);
  f.db.insertRepo({ id: "r", name: "fixture", path: f.dir, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  await f.service.init();
  writeFileSync(join(f.dir, "state/attachments"), "not a directory");
  assert.throws(() => f.service.createTask({ repoId: "r", agent: "codex", prompt: "Keep my image",
    images: [{ mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" }] }));
  assert.deepEqual(f.db.listTasks(), []);
  assert.deepEqual(f.service.listTasks(), []);
  assert.equal(f.db.attachmentIds().size, 0);
});
