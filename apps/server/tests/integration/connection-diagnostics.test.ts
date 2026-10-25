import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { diagnosticSessions } from "../../src/composition/diagnostic-sessions.js";
import { createConnectionDiagnostics, probePublicConnection } from "../../src/modules/installation/adapters/outbound/connection-diagnostics.js";
import { connectionCommand } from "../../src/modules/installation/adapters/inbound/connection-cli.js";
import { acquireUpdateLock } from "../../src/modules/installation/adapters/outbound/update-state.js";
import type { InstallConfig } from "../../src/modules/installation/domain/installation.js";

function installation(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "palmagent-connection-diagnostic-"));
  const previous = process.env.PALMAGENT_HOME;
  process.env.PALMAGENT_HOME = join(root, "preferences");
  const dbPath = join(root, "app.sqlite"), db = new Database(dbPath);
  db.exec("CREATE TABLE auth_sessions(token TEXT PRIMARY KEY, created_at INTEGER, expires_at INTEGER, label TEXT)");
  db.prepare("INSERT INTO auth_sessions VALUES (?, ?, ?, ?)").run("existing-session", 1, Date.now() + 1_000_000, "Existing device");
  writeFileSync(join(root, "install.env"), "AUTH_COOKIE_NAME=fixture_session\n");
  const cfg = { mode: "source", user: userInfo().username, dbPath, dataDir: root,
    domain: "app.example.com", authOrigin: "https://app.example.com" } as InstallConfig;
  t.after(() => {
    db.close(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PALMAGENT_HOME; else process.env.PALMAGENT_HOME = previous;
  });
  return { root, db, cfg };
}

for (const outcome of ["success", "failure", "interruption"] as const) {
  test(`connection diagnostic revokes only its temporary session on ${outcome}`, async t => {
    const f = installation(t), diagnose = createConnectionDiagnostics(diagnosticSessions);
    const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    let secret = "";
    const run = () => diagnose(f.cfg, async (origin, cookie, _version, signal) => {
      assert.equal(origin, f.cfg.authOrigin);
      secret = cookie.slice("fixture_session=".length);
      const row = f.db.prepare("SELECT created_at, expires_at FROM auth_sessions WHERE token = ?").get(secret) as { created_at: number; expires_at: number };
      assert.equal(row.expires_at - row.created_at, 120_000);
      if (outcome === "failure") throw new Error("probe failed");
      if (outcome === "interruption") {
        process.emit("SIGINT");
        assert.equal(signal.aborted, true);
        throw new Error("probe interrupted");
      }
    });
    if (outcome === "success") {
      const result = await run();
      assert.equal(result.status, "passed");
      assert.equal(result.vantage, "host");
      assert(result.checks.includes("public HTTPS health"));
      assert(!result.checks.includes("public HTTPS health/version"), "source installations must not claim a package version check");
      assert(!JSON.stringify(result).includes(secret));
    } else await assert.rejects(run(), /probe failed|probe interrupted/);
    assert.deepEqual(f.db.prepare("SELECT token FROM auth_sessions").all(), [{ token: "existing-session" }]);
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);
    acquireUpdateLock(process.env.PALMAGENT_HOME!)();
  });
}

test("diagnostics reject wrong owners, non-HTTPS origins and invalid cookies before creating a session", async t => {
  const f = installation(t), diagnose = createConnectionDiagnostics(diagnosticSessions);
  await assert.rejects(diagnose({ ...f.cfg, user: "another-owner" }), /installation owner/);
  await assert.rejects(diagnose({ ...f.cfg, authOrigin: "http://app.example.com" }), /exact HTTPS origin/);
  writeFileSync(join(f.root, "install.env"), "AUTH_COOKIE_NAME=invalid;cookie\n");
  await assert.rejects(diagnose(f.cfg), /cookie name/);
  assert.deepEqual(f.db.prepare("SELECT token FROM auth_sessions").all(), [{ token: "existing-session" }]);
});

test("a session store failure releases the diagnostic lock", async t => {
  const f = installation(t);
  await assert.rejects(createConnectionDiagnostics({ open() { throw new Error("store failed"); } })(f.cfg), /store failed/);
  acquireUpdateLock(process.env.PALMAGENT_HOME!)();
});

test("a failed session creation closes storage without deleting a session it did not create", async t => {
  const f = installation(t);
  let deleted = 0, closed = 0;
  const diagnose = createConnectionDiagnostics({ open: () => ({
    create() { throw new Error("creation failed"); }, delete() { deleted++; }, close() { closed++; },
  }) });
  await assert.rejects(diagnose(f.cfg), /creation failed/);
  assert.equal(deleted, 0); assert.equal(closed, 1);
  acquireUpdateLock(process.env.PALMAGENT_HOME!)();
});

async function publicServer(t: TestContext, behavior: string) {
  const requests: { path: string; cookie?: string }[] = [];
  const timers = new Set<ReturnType<typeof setInterval>>();
  const server = createServer((req, res) => {
    requests.push({ path: req.url!, cookie: req.headers.cookie });
    const send = (value: unknown) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
    if (req.url === "/api/health") return send({ ok: true, build: { version: behavior === "version" ? "other" : "fixture" } });
    if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Fixture</title>"); return; }
    if (req.url === "/api/auth/me") {
      if (behavior === "redirect") { res.writeHead(302, { location: "/unexpected" }); res.end(); return; }
      if (behavior === "invalid-json") { res.end("fixture-private-response"); return; }
      return send({ required: behavior !== "disabled", authenticated: behavior !== "auth" && req.headers.cookie === "session=valid" });
    }
    if (req.url === "/api/stream?snapshots=1") {
      res.setHeader("Content-Type", behavior === "mime" ? "application/json" : "text/event-stream");
      res.flushHeaders();
      if (behavior === "stall") return;
      if (behavior === "partial") { res.end("data: incomplete"); return; }
      if (behavior === "comments") { res.end(": keep-alive\n\n"); return; }
      const chunks = [": keep-alive\r\n\r\n", "da", "ta: {\"private\":\"fixture\"}", "\r\n", "\r\n"];
      const timer = setInterval(() => { if (chunks.length) res.write(chunks.shift()); else { clearInterval(timer); timers.delete(timer); } }, 5);
      timers.add(timer);
      res.once("close", () => { clearInterval(timer); timers.delete(timer); });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "localhost", resolve));
  t.after(async () => { for (const timer of timers) clearInterval(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { origin: `http://localhost:${(server.address() as { port: number }).port}`, requests };
}

test("public probe authenticates the real routes and receives a fragmented complete SSE frame", async t => {
  const f = await publicServer(t, "success");
  await probePublicConnection(f.origin, "session=valid", "fixture", new AbortController().signal);
  assert.deepEqual(f.requests.map(r => r.path), ["/api/health", "/", "/api/auth/me", "/api/stream?snapshots=1"]);
  assert(f.requests.slice(0, 2).every(r => r.cookie === undefined));
  assert(f.requests.slice(2).every(r => r.cookie === "session=valid"));
});

for (const behavior of ["version", "auth", "disabled", "invalid-json", "redirect", "mime", "partial", "comments", "stall"]) {
  test(`public probe rejects ${behavior} instead of claiming verified SSE`, async t => {
    const f = await publicServer(t, behavior);
    await assert.rejects(probePublicConnection(f.origin, "session=valid", "fixture", new AbortController().signal, behavior === "stall" ? 100 : 1000), (error: Error) => {
      assert(!error.message.includes("fixture-private-response")); return true;
    });
    assert(!f.requests.some(r => r.path === "/unexpected"), "redirect must not receive credentials");
  });
}

test("connection command retains bare JSON and exposes diagnostics only through an explicit subcommand", async t => {
  const output = t.mock.method(console, "log", () => {});
  const calls: string[] = [];
  const environment = {
    connection: (data?: string) => { calls.push(`read:${data}`); return { schemaVersion: 1 }; },
    diagnose: async (data?: string) => { calls.push(`diagnose:${data}`); return { status: "passed" }; },
  };
  await connectionCommand(["--data-dir", "/example/installation"], environment);
  assert.equal(output.mock.calls[0].arguments[0], '{"schemaVersion":1}');
  assert.deepEqual(calls, ["read:/example/installation"]);
  await connectionCommand(["diagnose", "--data-dir", "/example/installation"], environment);
  assert.equal(calls.at(-1), "diagnose:/example/installation");
  await connectionCommand(["--help"], environment);
  assert.match(String(output.mock.calls.at(-1)!.arguments[0]), /connection diagnose/);
  assert.equal(calls.length, 2);
  await assert.rejects(connectionCommand(["unrecognized"], environment));
  await assert.rejects(connectionCommand(["diagnose", "--unknown"], environment));
});
