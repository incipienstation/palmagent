import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ChildProcHandle, InProcessBackend } from "../../src/modules/agents/adapters/outbound/inproc-backend.js";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { ExecutionStore } from "../../src/modules/agents/adapters/outbound/execution-store.js";
import { ExecutionBackend } from "../../src/modules/agents/adapters/outbound/execution-client.js";
import { drainExecutionCommands } from "../../src/modules/agents/adapters/outbound/execution-commands.js";
import { ExecutionPersistence } from "../../src/modules/agents/adapters/outbound/execution-persistence.js";
import { watchExecutions, notifyExecutionCommands } from "../../src/modules/agents/adapters/outbound/execution-wake.js";
import type { RawEvent } from "../../src/modules/agents/domain/execution.js";
import type { ExecutionStart } from "@palmagent/shared/executions";

const until = async (check: () => boolean, label: string) => {
  for (let n = 0; n < 400; n++) { if (check()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`Timed out: ${label}`);
};
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "palmagent-executions-"));
  const store = new ExecutionStore(join(root, "executions"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store };
}
const request = (taskId: string): ExecutionStart => ({ taskId, agent: "codex", cwd: `/tmp/${taskId}`, prompt: "Fixture" });

test("execution admission, ownership and command receipts survive clients and reject duplicate intent", (t) => {
  const { store } = fixture(t);
  const first = store.reserve({ ...request("first"), messageId: "message-1" }, "/opt/releases/one", process.execPath);
  assert.equal(store.reserve({ ...request("first"), messageId: "message-1" }, "/opt/releases/two", process.execPath).id, first.id);
  assert.throws(() => store.reserve(request("first"), "/opt/releases/two", process.execPath));
  const second = store.reserve(request("second"), "/opt/releases/two", process.execPath);
  assert.deepEqual(store.admit(1).map((r) => r.id), [first.id]);
  assert.deepEqual(store.admit(1), []);
  assert(store.claim(first.id)); assert(!store.claim(first.id));
  store.append(first.id, { taskId: "first", kind: "question", payload: { requestId: "q", questions: [] } });
  const answer = { kind: "answer" as const, answer: { requestId: "q", answers: [] } };
  assert.equal(store.enqueue(first.id, "answer:q", answer), "accepted");
  assert.equal(store.enqueue(first.id, "answer:q", answer), "accepted");
  assert.equal(store.enqueue(first.id, "other-id", answer), "rejected");
  assert.throws(() => store.enqueue(first.id, "answer:q", { kind: "cancel" }));
  assert.equal(store.pending(first.id).length, 1);
  assert.equal(store.pending(first.id).length, 0, "uncertain claimed commands are not resent");
  store.finish(first.id, true);
  assert.equal(store.command(first.id, "answer:q")?.result, "unknown");
  assert.deepEqual(store.admit(1).map((r) => r.id), [second.id]);
});

for (const agent of ["claude", "codex"] as const) {
  test(`${agent}: application replacement retains the same execution and replays output and pending input`, { timeout: 25_000 }, async (t) => {
    const { root, store } = fixture(t);
    const children: ChildProcess[] = [];
    const clients: ExecutionBackend[] = [];
    let logs = "";
    t.after(async () => {
      for (const client of clients) client.close();
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Already exited. */ }
          await new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
        }
      }
    });
    for (const part of ["bin", "home", "control", "repo"]) mkdirSync(join(root, part));
    const cli = fileURLToPath(new URL("../support/lifecycle-cli.cjs", import.meta.url));
    writeFileSync(join(root, "bin", agent), `#!${process.execPath}\nprocess.argv.splice(2,0,${JSON.stringify(agent)}); require(${JSON.stringify(cli)});\n`, { mode: 0o700 });
    const launch = (record: ReturnType<ExecutionStore["get"]>) => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../src/bootstrap/execution-host.ts", import.meta.url)), store.directory, record.id], {
        detached: true, stdio: "pipe", env: { PATH: `${join(root, "bin")}:/usr/bin:/bin`, HOME: join(root, "home"), PROBE_CONTROL: join(root, "control") },
      });
      children.push(child); child.stdout?.on("data", (data) => { logs += data; }); child.stderr?.on("data", (data) => { logs += data; });
    };
    const create = (release: string) => { const client = new ExecutionBackend(store.directory, release, process.execPath, 2, launch); clients.push(client); return client; };
    const first = create("/opt/releases/one");
    const args = { taskId: "task", cwd: join(root, "repo"), prompt: JSON.stringify({ key: agent, mode: "answered-hold" }), interactive: true };
    const events: RawEvent[] = [];
    first.agentRunner(agent).start(args, (event) => events.push(event));
    const marker = (suffix: string) => join(root, "control", agent + suffix);
    await until(() => existsSync(marker(".ready")), `provider starts ${logs}`);
    const original = JSON.parse(readFileSync(marker(".ready"), "utf8"));
    const execution = store.latest("task")!;
    await until(() => events.some((event) => JSON.stringify(event).includes(`${agent}:before`)), "first event projection");
    first.close(); clients.splice(clients.indexOf(first), 1);
    writeFileSync(marker(".ping"), "");
    await until(() => store.get(execution.id).lastSeq > events.length, "output persists without a web client");
    process.kill(original.pid, 0);
    const second = create("/opt/releases/two");
    const replay: RawEvent[] = [];
    const handle = second.agentRunner(agent).start({ ...args, reattach: true }, (event) => replay.push(event));
    await until(() => replay.some((event) => JSON.stringify(event).includes(`${agent}:ping`)), "replay catches up");
    assert.equal(store.latest("task")!.id, execution.id);
    assert.equal(store.latest("task")!.release, "/opt/releases/one");
    assert.equal(children.length, 1, "reconnection must not start a replacement process");
    assert.deepEqual(JSON.parse(readFileSync(marker(".ready"), "utf8")), original);
    assert(await handle.answer({ requestId: agent === "claude" ? "q1" : '"q1"', answers: [{ question: "Continue?", selected: ["Yes"] }] }));
    await until(() => existsSync(marker(".answer")), "answer reaches the original stdin");
    // Final output must survive a writer held past the former five-second timeout.
    const blocker = new ExecutionStore(store.directory);
    t.after(() => blocker.close());
    blocker.db.exec("BEGIN IMMEDIATE");
    writeFileSync(marker(".release"), "");
    try {
      await new Promise(resolve => setTimeout(resolve, 6_000));
      assert.equal(children[0].exitCode, null, logs);
      assert.equal(store.get(execution.id).state, "running");
    } finally { blocker.db.exec("ROLLBACK"); }
    await handle.done;
    assert(replay.some((event) => JSON.stringify(event).includes(`${agent}:after`)), logs);
    assert.equal(store.get(execution.id).state, "finished");
    assert.match(logs, /execution_store_busy/);
    assert.match(logs, /execution_store_recovered/);
  });
}

test("cancellation serializes with admission and prevents a delayed host from claiming", t => {
  const { store } = fixture(t);
  const queued = store.reserve(request("queued"), "/opt/releases/one", process.execPath);
  assert.equal(store.cancelBeforeStart(queued.id), true);
  assert.deepEqual(store.admit(1), []);
  assert.equal(store.claim(queued.id), false);
  const starting = store.reserve(request("starting"), "/opt/releases/one", process.execPath);
  store.admit(1);
  assert.equal(store.cancelBeforeStart(starting.id), true);
  assert.equal(store.claim(starting.id), false);
  const running = store.reserve(request("running"), "/opt/releases/one", process.execPath);
  store.admit(1); store.claim(running.id);
  assert.equal(store.cancelBeforeStart(running.id), false);
  assert.equal(store.get(running.id).state, "running");
});

test("fresh sessions may share a directory, but an established provider session has one owner", t => {
  const { store } = fixture(t);
  const first = store.reserve(request("owner"), "/opt/releases/one", process.execPath);
  store.reserve({ ...request("other"), cwd: first.args.cwd }, "/opt/releases/one", process.execPath);
  store.admit(2); store.claim(first.id); store.bindSession(first.id, "provider-session");
  assert.throws(() => store.reserve({ ...request("duplicate"), resumeId: "provider-session" }, "/opt/releases/two", process.execPath));
  store.finish(first.id);
  assert(store.reserve({ ...request("later"), resumeId: "provider-session" }, "/opt/releases/two", process.execPath));
});

test("provider completion waits for final pipe data after process exit", () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  const handle = new ChildProcHandle("drain", child as unknown as ConstructorParameters<typeof ChildProcHandle>[1]);
  const observed: string[] = [];
  handle.onLine((_seq, line) => observed.push(line));
  handle.onExit(code => observed.push(`exit:${code}`));
  child.stdout.write("first\n");
  child.emit("exit", 0);
  child.stdout.write("last");
  assert.deepEqual(observed, ["first"]);
  child.emit("close", 0);
  assert.deepEqual(observed, ["first", "last", "exit:0"]);
});

test("a failed provider spawn completes exactly once", async t => {
  const backend = new InProcessBackend();
  t.after(() => backend.close());
  const handle = backend.start({ turnId: "missing", command: "/nonexistent/palmagent-test-provider", argv: [], cwd: tmpdir() });
  const exits: Array<number | null> = [];
  await new Promise<void>(resolve => handle.onExit(code => { exits.push(code); resolve(); }));
  assert.deepEqual(exits, [-1]);
});

test("retained executions without skill capability reject selection before enqueueing a command", async t => {
  const { store } = fixture(t);
  const old = store.reserve(request("legacy-skills"), "/opt/releases/previous", process.execPath);
  const backend = new ExecutionBackend(store.directory, "/opt/releases/current", process.execPath, 1, () => {});
  t.after(() => backend.close());
  const handle = backend.agentRunner("codex").start({ taskId: "legacy-skills", cwd: "/tmp/legacy-skills", prompt: "", reattach: true }, () => {});
  const result = await handle.send!("Check", undefined, "skill-message", [{ id: "skill", name: "doctor", source: "repo" }]);
  assert.equal(result, "rejected");
  assert.deepEqual(store.pending(old.id), []);
});

test("skill inputs persist beside v1 args without breaking older execution readers", t => {
  const { store } = fixture(t);
  const skills = [{ id: "skill", name: "palmagent:doctor", source: "palmagent" }];
  const args = { ...request("selected-skill"), messageId: "selected-message" };
  const record = store.reserve(args, "/opt/releases/current", process.execPath, skills);
  assert.deepEqual(store.get(record.id).skills, skills);
  const raw = store.db.prepare("SELECT args FROM executions WHERE id=?").get(record.id) as { args: string };
  assert.deepEqual(JSON.parse(raw.args), args, "v1 readers see unchanged argument shape");
  assert.equal(store.reserve(args, record.release, process.execPath, skills).id, record.id);
  assert.throws(() => store.reserve(args, record.release, process.execPath, []), /already owns/);
});

test("context compaction operation is preserved across the execution process boundary", async t => {
  const { store } = fixture(t);
  const client = new ExecutionBackend(store.directory, "/opt/releases/current", process.execPath, 1, () => {});
  t.after(() => client.close());
  client.agentRunner("codex").start({ taskId: "compact", cwd: "/tmp/workspace", prompt: "", resumeId: "existing-thread", interactive: true, operation: "compact" }, () => {});
  const record = store.latest("compact")!;
  assert.equal(record.args.operation, "compact");
  assert.equal(record.args.resumeId, "existing-thread");
  assert.equal(record.args.prompt, "");
});

test("empty command and admission checks do not acquire a write lock", t => {
  const { store } = fixture(t);
  const record = store.reserve(request("idle"), "/opt/releases/one", process.execPath);
  store.admit(1); store.claim(record.id);
  const blocker = new ExecutionStore(store.directory);
  t.after(() => blocker.close());
  store.db.pragma("busy_timeout = 0");
  blocker.db.exec("BEGIN IMMEDIATE");
  try {
    assert.deepEqual(store.pending(record.id), []);
    assert.deepEqual(store.admit(1), []);
  } finally { blocker.db.exec("ROLLBACK"); }
});

test("command claim and receipt retry preserve one delivery under real write contention", async t => {
  const { store } = fixture(t);
  const record = store.reserve(request("receipt"), "/opt/releases/one", process.execPath);
  store.admit(1); store.claim(record.id);
  store.append(record.id, { taskId: record.taskId, kind: "question", payload: { requestId: "q", questions: [] } });
  store.enqueue(record.id, "answer", { kind: "answer", answer: { requestId: "q", answers: [] } });
  const blocker = new ExecutionStore(store.directory);
  const reports: string[] = [];
  const persistence = new ExecutionPersistence(message => reports.push(message));
  t.after(() => { persistence.close(); blocker.close(); });
  store.db.pragma("busy_timeout = 0");
  const unlock = async <T>(operation: () => Promise<T>) => {
    blocker.db.exec("BEGIN IMMEDIATE");
    const result = operation();
    try {
      await until(() => reports.some(line => line.includes('"event":"execution_store_busy"')), "retry starts");
    } finally { blocker.db.exec("ROLLBACK"); }
    return result;
  };
  let deliveries = 0;
  let releaseReceipt: Promise<void> | undefined;
  const handle = {
    answer: () => {
      deliveries++;
      assert.deepEqual(blocker.pending(record.id), [], "another reader cannot reclaim delivery");
      blocker.db.exec("BEGIN IMMEDIATE");
      releaseReceipt = until(() => reports.some(line => line.includes('"operation":"settle"')), "receipt retry starts")
        .finally(() => blocker.db.exec("ROLLBACK"));
      return true;
    },
    steer: () => false, approve: () => false, interrupt: () => false, cancel: () => {}, done: new Promise<void>(() => {}),
  };
  await unlock(() => drainExecutionCommands(store, persistence, record.id, handle, () => false));
  await releaseReceipt;
  await drainExecutionCommands(store, persistence, record.id, handle, () => false);
  assert.equal(deliveries, 1);
  assert.equal(store.command(record.id, "answer")?.result, "delivered");
  assert.equal(store.get(record.id).question, null);
  assert.equal(store.events(record.id, 0).filter(row => (row.event.payload as { subtype?: string }).subtype === "answer").length, 1);
  assert.deepEqual(store.pending(record.id), []);
  assert(reports.some(line => line.includes("execution_store_recovered")));
});

test("permanent persistence errors stop the ordered queue without retrying later writes", async t => {
  const persistence = new ExecutionPersistence(() => {});
  t.after(() => persistence.close());
  let calls = 0;
  const failure = Object.assign(new Error("synthetic storage failure"), { code: "SQLITE_FULL" });
  await assert.rejects(persistence.run("event", () => { calls++; throw failure; }), failure);
  await assert.rejects(persistence.run("finish", () => { calls++; }), failure);
  assert.equal(calls, 1);
});

test("command hints wake only their execution and legacy clients retain periodic reconciliation", async t => {
  const { store } = fixture(t);
  let wakes = 0;
  const dispose = watchExecutions(store.directory, () => { wakes++; }, "target");
  t.after(dispose);
  notifyExecutionCommands(store.directory, "other");
  writeFileSync(join(store.directory, "executions.sqlite-wal-hint"), "unrelated output");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(wakes, 0);
  notifyExecutionCommands(store.directory, "target");
  await until(() => wakes > 0, "target hint");
  const before = wakes;
  await until(() => wakes > before, "periodic reconciliation without a hint");
});

test("an exhausted busy retry window fails explicitly and does not run later writes", async t => {
  const reports: string[] = [];
  const persistence = new ExecutionPersistence(message => reports.push(message), 0);
  t.after(() => persistence.close());
  const busy = Object.assign(new Error("synthetic lock contention"), { code: "SQLITE_BUSY" });
  let calls = 0;
  await assert.rejects(persistence.run("event", () => { calls++; throw busy; }), busy);
  await assert.rejects(persistence.run("finish", () => { calls++; }), busy);
  assert.equal(calls, 1);
  persistence.close();
  const metrics = JSON.parse(reports.find(line => line.includes("execution_store_metrics"))!);
  assert.equal(metrics.operations.event.busyRetries, 1);
  assert.equal(metrics.operations.event.calls, 0);
});
