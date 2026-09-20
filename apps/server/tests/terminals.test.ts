import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TerminalStore } from "../src/terminal/store.js";
import { TerminalHost } from "../src/terminal/host.js";
import { linuxSupervisor, ptyDriver, unixTransport } from "../src/terminal/linux.js";
import { TerminalTickets, installTerminalGateway } from "../src/terminal/gateway.js";
import type { TerminalFrame } from "@palmagent/shared/terminals";
import type { LocalChannel } from "../src/terminal/platform.js";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { TerminalService } from "../src/terminal/service.js";
import type { AuthService } from "../src/auth.js";
import { ViewerOutput } from "../src/terminal/viewer-output.js";
import { terminalPlatform } from "../src/terminal/adapters.js";
import { Hono } from "hono";
import { terminalRoutes } from "../src/http/routes/terminals.js";
import { handleError } from "../src/http/errors.js";
import { terminalInputChunks } from "@palmagent/shared/terminals";

const waitFor = async (predicate: () => boolean, label = "condition") => {
  const limit = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > limit) throw new Error("Timed out: " + label); await new Promise(r => setTimeout(r, 10)); }
};
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "palmagent-terminal-test-"));
  const cwd = join(directory, "project"); mkdirSync(cwd);
  const store = new TerminalStore(join(directory, "terminals"));
  const reserve = (requestId = randomUUID()) => store.reserve({ requestId, repoId: "repo", taskId: "task", title: "Shell",
    initialCwd: cwd, release: directory, node: process.execPath, directory: store.directory, cols: 80, rows: 24 });
  return { directory, cwd, store, reserve, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test("terminal reservations deduplicate and retain worktrees until confirmed termination", () => {
  const f = fixture();
  try {
    const key = randomUUID();
    const first = f.reserve(key);
    assert.equal(f.reserve(key).record.id, first.record.id);
    assert.equal(f.reserve(key).created, false);
    assert.equal(f.store.claim(first.record.id, process.pid, "instance"), true);
    assert.equal(f.store.claim(first.record.id, process.pid, "instance"), false);
    let removed = false;
    assert.equal(f.store.cleanup(f.cwd, "task", () => { removed = true; }), false);
    assert.equal(removed, false);
    assert.throws(() => f.reserve(), /pending cleanup/);
    f.store.update(first.record.id, { state: "closing" });
    assert.equal(f.store.cleanup(f.cwd, "task", () => { removed = true; }), false);
    f.store.update(first.record.id, { state: "exited" });
    assert.equal(f.store.cleanup(f.cwd, "task", () => { removed = true; }), true);
    assert.equal(removed, true);
    assert.deepEqual(f.store.pendingCleanup(), []);
  } finally { f.close(); }
});
test("attach tickets are single-use and bound to terminal and login session", () => {
  const tickets = new TerminalTickets();
  const token = tickets.issue("session", "one").ticket;
  assert.equal(tickets.consume(token, "other", "one"), false);
  assert.equal(tickets.consume(token, "session", "one"), false);
  const next = tickets.issue("session", "one").ticket;
  assert.equal(tickets.consume(next, "session", "one"), true);
  assert.equal(tickets.consume(next, "session", "one"), false);
});

test("native viewers suppress split terminal queries while preserving screen controls", () => {
  const viewer = new ViewerOutput();
  assert.equal(viewer.write("hello\x1b["), "hello");
  assert.equal(viewer.write("6n\x1b[31mred\x1b[0m"), "\x1b[31mred\x1b[0m");
  assert.equal(viewer.write("\x1b]52;c;secret\x07"), "");
  assert.equal(viewer.write("\x1bP$qm\x1b\\"), "");
  assert.equal(viewer.write("\x1b[?1049h\x1b[2J"), "\x1b[?1049h\x1b[2J");
});

test("unsupported platforms advertise capabilities without starting a service", async () => {
  const platform = terminalPlatform(true, "win32");
  assert.deepEqual([platform.supervisor.capabilities.available, platform.supervisor.capabilities.persistent], [false, false]);
  await assert.rejects(platform.transport.connect("", ""), /not yet supported/);
});

test("terminal REST rejects cross-origin and arbitrary cwd requests, and retries launch exactly once", async () => {
  const f = fixture();
  let launches = 0, stopped = false;
  const terminals = new TerminalService(f.store, {
    capabilities: { available: true, persistent: true },
    async launch(record) { launches++; f.store.update(record.id, { state: "running" }); },
    async terminate() { stopped = true; }, alive: async () => !stopped,
  }, {
    task() { throw new Error("No task"); },
    repo: id => id === "repo" ? { id, name: "Fixture", path: f.cwd, vcs: "none", defaultBaseRef: "", createdAt: 1 } : undefined,
    cleanup() {}, updating: () => false,
  }, f.directory, process.execPath);
  const app = new Hono().onError(handleError).route("/api/terminals", terminalRoutes({
    auth: { enabled: true, origin: "https://app.example.com", sessionValid: (token: string) => token === "valid" } as unknown as AuthService,
    terminals, terminalTickets: new TerminalTickets(),
    config: { cookieName: "session", repoRoots: [], staticDir: "", keepAliveMs: 15_000 },
  }));
  const headers = { origin: "https://app.example.com", "content-type": "application/json", cookie: "session=valid" };
  const body = { target: { repoId: "repo" }, requestId: randomUUID(), cols: 80, rows: 24 };
  try {
    assert.equal((await app.request("/api/terminals", { method: "POST", body: JSON.stringify(body), headers: { ...headers, origin: "https://other.example.com" } })).status, 403);
    assert.equal((await app.request("/api/terminals", { method: "POST", body: JSON.stringify({ ...body, cwd: f.directory }), headers })).status, 400);
    let id = "";
    for (let i = 0; i < 2; i++) {
      const response = await app.request("/api/terminals", { method: "POST", body: JSON.stringify(body), headers });
      assert.equal(response.status, 201);
      const value = await response.json();
      if (id) assert.equal(value.terminal.id, id);
      id = value.terminal.id;
      assert.equal(value.terminal.initialCwd, f.cwd);
      assert.equal(value.terminal.release, undefined);
    }
    assert.equal(launches, 1);
    assert.equal((await app.request("/api/terminals/" + id + "/attach-ticket", { method: "POST", headers })).status, 200);
    assert.equal((await app.request("/api/terminals/" + id + "/terminate", { method: "POST", headers })).status, 200);
    assert.equal(stopped, true);
    assert.equal(f.store.get(id)?.state, "exited");
  } finally { f.close(); }
});

test("large Unicode pastes stay within the input contract", () => {
  const data = "x".repeat(16_383) + "😀".repeat(20_000);
  const chunks = [...terminalInputChunks(data)];
  assert.equal(chunks.join(""), data);
  assert(chunks.every(chunk => chunk.length <= 16_384 && !/[\uD800-\uDBFF]$/.test(chunk)));
});

test("real PTY preserves screen on reattach and fences previous input/resize owners", { skip: process.platform !== "linux" }, async () => {
  const f = fixture();
  const record = f.reserve().record;
  let exit: number | undefined;
  const host = new TerminalHost(record, ptyDriver, { resolve: () => ({ executable: "/bin/sh", args: [], env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color", PS1: "" } }) }, code => { exit = code; });
  const closeListener = await unixTransport.listen(f.store.directory, record.id, c => host.attach(c));
  const channels: LocalChannel[] = [];
  async function attach() {
    const channel = await unixTransport.connect(f.store.directory, record.id); channels.push(channel);
    const frames: TerminalFrame[] = [];
    channel.onMessage(value => {
      const frame = value as TerminalFrame; frames.push(frame);
      if ("seq" in frame) channel.send({ type: "ack", seq: frame.seq });
    });
    await waitFor(() => frames.some(f => f.type === "snapshot"));
    return { channel, frames, text: () => frames.filter(f => f.type === "output" || f.type === "snapshot").map(f => f.data).join(""),
      epoch: () => frames.filter(f => f.type === "control").at(-1)?.epoch ?? 0 };
  }
  try {
    const first = await attach();
    assert.equal(first.frames.find(f => f.type === "control")?.writable, false);
    first.channel.send({ type: "claim-control" }); await waitFor(() => first.epoch() > 0);
    const epoch = first.epoch();
    first.channel.send({ type: "input", epoch, data: "printf 'BEFORE-%s\\n' 'DETACH'\r" });
    await waitFor(() => first.text().includes("BEFORE-DETACH"));
    first.channel.close();
    const second = await attach();
    assert.ok(second.frames.some(f => f.type === "snapshot" && f.data.includes("BEFORE-DETACH")));
    second.channel.send({ type: "claim-control" }); await waitFor(() => second.epoch() > epoch);
    const third = await attach();
    const old = second.epoch();
    third.channel.send({ type: "claim-control" }); await waitFor(() => third.epoch() > old);
    second.channel.send({ type: "input", epoch: old, data: "printf 'BAD-%s' 'WRITER'\r" });
    second.channel.send({ type: "resize", epoch: old, cols: 7, rows: 7 });
    third.channel.send({ type: "resize", epoch: third.epoch(), cols: 100, rows: 30 });
    third.channel.send({ type: "input", epoch: third.epoch(), data: "stty size; printf 'GOOD-%s\\n' 'WRITER'\r" });
    await waitFor(() => third.text().includes("GOOD-WRITER"));
    assert.ok(third.text().includes("30 100"));
    assert.ok(!third.text().includes("BAD-WRITER"));
    // Alternate screen state must survive a disconnected viewer.
    third.channel.send({ type: "input", epoch: third.epoch(), data: "printf '\\033[?1049h\\033[2J\\033[HALT-SCREEN'\r" });
    await waitFor(() => third.text().includes("ALT-SCREEN"));
    const fourth = await attach();
    assert.ok(fourth.frames.some(f => f.type === "snapshot" && f.data.includes("ALT-SCREEN")));
    third.channel.send({ type: "input", epoch: third.epoch(), data: "exit 7\r" });
    await waitFor(() => exit !== undefined);
    assert.equal(exit, 7);
  } finally { host.terminate(); for (const c of channels) c.close(); closeListener(); host.close(); f.close(); }
});

test("WebSocket rejects foreign origins and revoked sessions, and reconnects without relaunching the shell", async () => {
  const f = fixture();
  const record = f.reserve().record; f.store.update(record.id, { state: "running" });
  let valid = true, connections = 0;
  const channels: LocalChannel[] = [];
  const service = new TerminalService(f.store, {
    capabilities: { available: true, persistent: true }, async launch() { throw new Error("Must not launch"); }, async terminate() {}, alive: async () => true,
  }, { task() { throw new Error(); }, repo: () => undefined, cleanup() {}, updating: () => false }, "", "");
  const tickets = new TerminalTickets();
  const auth = { enabled: true, sessionValid: (token: string) => valid && token === "session" } as AuthService;
  const transport = {
    async connect() { connections++; const c: LocalChannel = { send() { return true; }, close() {}, onClose() {}, onMessage() {} }; channels.push(c); return c; },
    async listen() { return () => {}; },
  };
  const server = createServer();
  const close = installTerminalGateway(server, { service, auth, tickets, transport, origin: "https://app.example.com", cookieName: "session" });
  await new Promise<void>(resolve => server.listen(0, "localhost", resolve));
  const address = server.address() as { port: number };
  const url = "ws://localhost:" + address.port + "/api/terminals/" + record.id + "/stream";
  const open = (origin = "https://app.example.com") => new WebSocket(url, { headers: { origin, cookie: "session=session" } });
  const sockets: WebSocket[] = [];
  try {
    const denied = open("https://other.example.com"); sockets.push(denied);
    await new Promise<void>(resolve => denied.on("error", () => resolve()));
    assert.equal(connections, 0);
    for (let i = 0; i < 2; i++) {
      const ws = open(); sockets.push(ws);
      await new Promise<void>(resolve => ws.on("open", resolve));
      ws.send(JSON.stringify({ type: "attach", ...tickets.issue("session", record.id) }));
      await waitFor(() => connections === i + 1);
      if (i === 0) { ws.close(); await new Promise<void>(r => ws.on("close", () => r())); }
      else {
        valid = false; ws.send(JSON.stringify({ type: "claim-control" }));
        await new Promise<void>(r => ws.on("close", () => r()));
      }
    }
    assert.equal(f.store.get(record.id)?.state, "running");
  } finally { for (const ws of sockets) ws.terminate(); close(); await new Promise<void>(r => server.close(() => r())); f.close(); }
});


test("missing services explain pending shells and recover the same reservation after setup", async () => {
  const f = fixture();
  let installed = false, launches = 0, fail = true;
  const supervisor = linuxSupervisor(true, () => installed);
  supervisor.launch = async record => {
    launches++;
    if (fail) throw new Error("private host detail");
    f.store.claim(record.id, process.pid, "recovered");
    f.store.ready(record.id, process.pid, "recovered");
  };
  const service = new TerminalService(f.store, supervisor, {
    task() { throw new Error(); }, repo: () => undefined, cleanup() {}, updating: () => false,
  }, f.directory, process.execPath);
  try {
    await assert.rejects(service.create({ target: { repoId: "repo" }, requestId: randomUUID(), cols: 80, rows: 24 }), /setup/);
    assert.equal(f.store.list().length, 0);
    const record = f.reserve().record;
    await service.reconcile();
    assert.equal(launches, 0);
    assert.match(service.list()[0].startError!, /setup/);
    installed = true;
    await service.reconcile();
    assert.equal(launches, 1);
    assert.match(service.list()[0].startError!, /retry this terminal/);
    assert(!JSON.stringify(service.list()).includes("private host detail"));
    fail = false;
    await service.reconcile();
    assert.equal(launches, 2);
    assert.equal(service.list().length, 1);
    assert.equal(service.list()[0].id, record.id);
    assert.equal(service.list()[0].state, "running");
    assert.equal(service.list()[0].startError, undefined);
  } finally { f.close(); }
});

test("claiming a host does not advertise readiness and expired hosts cannot become ready", () => {
  const f = fixture();
  try {
    const id = f.reserve().record.id;
    assert.equal(f.store.claim(id, 123, "owner"), true);
    assert.equal(f.store.get(id)?.state, "starting");
    assert.equal(f.store.ready(id, 124, "owner"), false);
    assert.equal(f.store.ready(id, 123, "other"), false);
    assert.equal(f.store.ready(id, 123, "owner"), true);
    assert.equal(f.store.get(id)?.state, "running");
    assert.equal(f.store.expireStartup(id), false);
    const late = f.reserve().record.id;
    f.store.claim(late, 123, "late");
    f.store.update(late, { createdAt: Date.now() - 31_000 });
    assert.equal(f.store.ready(late, 123, "late"), false);
    assert.equal(f.store.get(late)?.startErrorCode, "startup_timeout");
    assert.equal(f.store.get(late)?.state, "starting");
  } finally { f.close(); }
});

test("startup timeout retains uncertain processes, fences late readiness and never relaunches", async () => {
  const f = fixture();
  let stops = 0, allowStop = false, launches = 0;
  const service = new TerminalService(f.store, {
    capabilities: { available: true, persistent: true },
    async launch() { launches++; }, async terminate() { stops++; if (!allowStop) throw new Error("uncertain"); }, alive: async () => true,
  }, { task() { throw new Error(); }, repo: () => undefined, cleanup() {}, updating: () => false }, "", "");
  try {
    const id = f.reserve().record.id;
    f.store.claim(id, 123, "late");
    f.store.update(id, { createdAt: Date.now() - 31_000 });
    await service.reconcile();
    assert.equal(f.store.get(id)?.state, "starting");
    assert.equal(f.store.ready(id, 123, "late"), false);
    f.store.noteStartError(id, "launch_unconfirmed", "late error");
    assert.equal(f.store.get(id)?.startErrorCode, "startup_timeout");
    assert.equal(f.store.cleanup(f.cwd, "task", () => assert.fail("must retain cwd")), false);
    f.store.update(id, { state: "closing" }); // Host reacts to SIGTERM while stop remains uncertain.
    await service.reconcile();
    assert.equal(f.store.get(id)?.state, "closing");
    allowStop = true;
    await service.reconcile();
    assert.equal(f.store.get(id)?.state, "lost");
    assert.equal(f.store.get(id)?.startErrorCode, "startup_timeout");
    assert.equal(f.store.cleanup(f.cwd, "task", () => {}), true);
    await service.reconcile();
    assert.equal(stops, 3);
    assert.equal(launches, 0);
  } finally { f.close(); }
});

test("a claimed host that exits before readiness is reported without launching a duplicate", async () => {
  const f = fixture();
  const service = new TerminalService(f.store, {
    capabilities: { available: true, persistent: true },
    async launch() { assert.fail("must not relaunch a claimed host"); }, async terminate() {}, alive: async () => false,
  }, { task() { throw new Error(); }, repo: () => undefined, cleanup() {}, updating: () => false }, "", "");
  try {
    const id = f.reserve().record.id;
    f.store.claim(id, 123, "dead");
    await service.reconcile();
    assert.equal(f.store.get(id)?.state, "lost");
    assert.equal(f.store.get(id)?.startErrorCode, "host_exited");
  } finally { f.close(); }
});


test("one diagnostic can run at full user capacity and cannot be removed while active", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 16; i++) f.reserve();
    assert.throws(() => f.reserve(), /limit: 16/);
    const reserveDiagnostic = () => f.store.reserve({ diagnostic: true, requestId: randomUUID(), repoId: "diagnostic", title: "Diagnostic",
      initialCwd: f.cwd, release: f.directory, node: process.execPath, directory: f.store.directory, cols: 80, rows: 24 });
    const id = reserveDiagnostic().record.id;
    assert.throws(reserveDiagnostic, /diagnostic is already active/);
    assert.throws(() => f.store.removeDiagnostic(id), /termination must be confirmed/);
    f.store.update(id, { state: "exited" }); f.store.removeDiagnostic(id);
    assert.equal(f.store.list().length, 16);
  } finally { f.close(); }
});
