import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { ExecutionStore } from "../src/execution/store.js";
import { ExecutionBackend } from "../src/execution/client.js";
import type { RawEvent } from "../src/types.js";
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
    const cli = fileURLToPath(new URL("./fixtures/lifecycle-cli.cjs", import.meta.url));
    writeFileSync(join(root, "bin", agent), `#!${process.execPath}\nprocess.argv.splice(2,0,${JSON.stringify(agent)}); require(${JSON.stringify(cli)});\n`, { mode: 0o700 });
    const launch = (record: ReturnType<ExecutionStore["get"]>) => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/execution-host.ts", import.meta.url)), store.directory, record.id], {
        detached: true, stdio: "pipe", env: { PATH: `${join(root, "bin")}:/usr/bin:/bin`, HOME: join(root, "home"), PROBE_CONTROL: join(root, "control") },
      });
      children.push(child); child.stdout?.on("data", (data) => { logs += data; }); child.stderr?.on("data", (data) => { logs += data; });
    };
    const create = (release: string) => { const client = new ExecutionBackend(store.directory, release, process.execPath, 2, launch); clients.push(client); return client; };
    const first = create("/opt/releases/one");
    const args = { taskId: "task", cwd: join(root, "repo"), prompt: JSON.stringify({ key: agent, mode: agent === "claude" ? "answered-hold" : "hold" }), interactive: true };
    const events: RawEvent[] = [];
    first.agentRunner(agent).start(args, (event) => events.push(event), first);
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
    const handle = second.agentRunner(agent).start({ ...args, reattach: true }, (event) => replay.push(event), second);
    await until(() => replay.some((event) => JSON.stringify(event).includes(`${agent}:ping`)), "replay catches up");
    assert.equal(store.latest("task")!.id, execution.id);
    assert.equal(store.latest("task")!.release, "/opt/releases/one");
    assert.equal(children.length, 1, "reconnection must not start a replacement process");
    assert.deepEqual(JSON.parse(readFileSync(marker(".ready"), "utf8")), original);
    if (agent === "claude") {
      assert(handle.answer({ requestId: "q1", answers: [{ question: "Continue?", selected: ["Yes"] }] }));
      await until(() => existsSync(marker(".answer")), "answer reaches the original stdin");
    }
    writeFileSync(marker(".release"), "");
    await handle.done;
    assert(replay.some((event) => JSON.stringify(event).includes(`${agent}:after`)), logs);
    assert.equal(store.get(execution.id).state, "finished");
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
