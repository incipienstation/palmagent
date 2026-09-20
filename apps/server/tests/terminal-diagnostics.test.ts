import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { diagnoseTerminal, probeTerminalConnection } from "../src/cli/terminal-diagnostics.js";
import type { InstallConfig } from "../src/cli/config.js";
import { TerminalStore } from "../src/terminal/store.js";
import { TerminalHost } from "../src/terminal/host.js";
import { TerminalService } from "../src/terminal/service.js";
import { terminalPlatform } from "../src/terminal/adapters.js";
import { TerminalTickets, installTerminalGateway } from "../src/terminal/gateway.js";
import { handleError } from "../src/http/errors.js";
import { terminalRoutes } from "../src/http/routes/terminals.js";
import type { AuthService } from "../src/auth.js";
import { acquireUpdateLock } from "../src/cli/update-state.js";

for (const failure of ["none", "probe", "stop", "permissions"] as const) test(`diagnostic cleans credentials and preserves uncertain processes: ${failure}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "palmagent-diagnostic-"));
  const oldHome = process.env.PALMAGENT_HOME;
  process.env.PALMAGENT_HOME = join(root, "preferences");
  const pkgDir = join(root, "package"); mkdirSync(pkgDir);
  const dbPath = join(root, "app.sqlite");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE auth_sessions(token TEXT PRIMARY KEY, created_at INTEGER, expires_at INTEGER, label TEXT)");
  writeFileSync(join(pkgDir, "runtime-contract.json"), JSON.stringify({ executionProtocol: 1, productStorage: 1, applicationApi: 1, terminalProtocol: 1 }));
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "0.1.0-alpha.1" }));
  for (const name of ["cli", "server", "execution-host", "execution-launcher", "terminal-host", "terminal-launcher"]) writeFileSync(join(pkgDir, name + ".js"), "");
  writeFileSync(join(root, "install.env"), "AUTH_COOKIE_NAME=fixture_session\n");
  const cfg = { mode: "package", user: userInfo().username, dbPath, dataDir: root, executionNode: process.execPath, pkgDir,
    domain: "app.example.com", authOrigin: "https://app.example.com" } as InstallConfig;
  const store = new TerminalStore(join(root, "terminals"));
  let launches = 0, stops = 0, probes = 0;
  const platform = terminalPlatform(true);
  platform.supervisor = {
    capabilities: { available: true, persistent: true },
    async inspect() { if (failure === "permissions") throw new Error("permissions failed"); },
    async launch(record) { launches++; store.claim(record.id, 123, "fixture"); store.ready(record.id, 123, "fixture"); },
    async terminate() { stops++; if (failure === "stop") throw new Error("uncertain stop"); }, alive: async () => true,
  };
  try {
    const run = () => diagnoseTerminal(cfg, { platform, probe: async (origin, cookie, id) => {
      probes++; assert.equal(origin, cfg.authOrigin);
      const token = cookie.slice("fixture_session=".length);
      assert.ok(db.prepare("SELECT token FROM auth_sessions WHERE token = ?").get(token));
      assert.equal(store.get(id)?.diagnostic, true);
      if (failure === "probe") throw new Error("probe failed");
    } });
    if (failure === "none") assert.equal((await run()).status, "passed");
    else await assert.rejects(run(), failure === "stop" ? /cleanup could not be confirmed/ : new RegExp(failure + " failed"));
    assert.equal(launches, failure === "permissions" ? 0 : 1);
    assert.equal(stops, launches); assert.equal(probes, launches);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get() as { count: number }).count, 0);
    if (failure === "stop") {
      assert.equal(store.list().length, 1);
      const remaining = store.list()[0];
      assert.equal(remaining.state, "running");
      assert.equal(remaining.diagnostic, true);
      assert.equal(remaining.diagnosticCleanupFailed, true);
      assert.ok(existsSync(remaining.initialCwd));
    } else {
      assert.deepEqual(store.list(), []);
      assert.equal(readdirSync(root).filter(name => name.startsWith("terminal-diagnostic-")).length, 0);
      assert.equal(readdirSync(store.directory).filter(name => name.endsWith(".json")).length, 0);
    }
    acquireUpdateLock(process.env.PALMAGENT_HOME!)();
  } finally {
    if (oldHome === undefined) delete process.env.PALMAGENT_HOME; else process.env.PALMAGENT_HOME = oldHome;
    db.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("public diagnostic executes through authenticated WebSocket and verifies a restored PTY screen", async () => {
  const root = mkdtempSync(join(tmpdir(), "palmagent-probe-"));
  const store = new TerminalStore(join(root, "terminals"));
  const platform = terminalPlatform(true);
  const record = store.reserve({ diagnostic: true, requestId: "probe", repoId: "probe", title: "probe", initialCwd: root,
    directory: store.directory, node: process.execPath, release: root, cols: 120, rows: 24 }).record;
  const host = new TerminalHost(record, platform.driver, { resolve: () => ({ executable: "/bin/sh", args: [], env: { TERM: "xterm-256color", PATH: process.env.PATH! } }) }, () => {});
  const unlisten = await platform.transport.listen(store.directory, record.id, channel => host.attach(channel));
  store.claim(record.id, process.pid, "probe"); assert.equal(await host.isReady(), true); store.ready(record.id, process.pid, "probe");
  // The fixture starts its own PTY host; it does not require installed system services.
  const supervisor = { ...platform.supervisor, capabilities: { available: true, persistent: true } };
  const service = new TerminalService(store, supervisor, { task() { throw new Error(); }, repo: () => undefined, cleanup() {}, updating: () => false }, "", "");
  const tickets = new TerminalTickets();
  const auth = { enabled: true, sessionValid: (token: string) => token === "valid", origin: "" } as unknown as AuthService;
  const app = new Hono().onError(handleError).route("/api/terminals", terminalRoutes({ auth, terminals: service, terminalTickets: tickets,
    config: { cookieName: "session", repoRoots: [], staticDir: "", keepAliveMs: 15_000 } }));
  const server = createServer(getRequestListener(app.fetch));
  await new Promise<void>(r => server.listen(0, "localhost", r));
  const origin = `http://localhost:${(server.address() as { port: number }).port}`;
  Object.assign(auth, { origin });
  const close = installTerminalGateway(server, { service, auth, tickets, transport: platform.transport, origin, cookieName: "session" });
  try {
    assert.deepEqual(service.list(), []); // Temporary checks do not clutter the user's list.
    await probeTerminalConnection(origin, "session=valid", record.id, "0.1.0-alpha.1", platform.shell.diagnosticCommand!, new AbortController().signal);
    await assert.rejects(probeTerminalConnection(origin, "session=invalid", record.id, "0.1.0-alpha.1", platform.shell.diagnosticCommand!, new AbortController().signal), /authentication/);
  } finally { close(); host.terminate(); host.close(); unlisten(); await new Promise<void>(r => server.close(() => r())); store.close(); rmSync(root, { recursive: true, force: true }); }
});
