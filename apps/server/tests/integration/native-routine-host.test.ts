import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoutineHostStore } from "../../src/modules/routines/adapters/outbound/routine-host-store.js";

const binary = fileURLToPath(new URL("../../../../target/debug/palmagent-runtime", import.meta.url));
async function until(check: () => unknown, label: string) {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timed out: ${label}`);
}
function running(pid: number) {
  try { return !/[)] [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "native-routine-host-"));
  const store = new RoutineHostStore(join(root, "routines"));
  const hosts: ChildProcess[] = [];
  let sequence = 0;
  t.after(async () => {
    for (const host of hosts) if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    await until(() => hosts.every(h => h.exitCode !== null || h.signalCode !== null), "fixture hosts exit");
    rmSync(root, { recursive: true, force: true });
  });
  const create = (command: string, timeoutSeconds = 10) => {
    const runId = ++sequence, id = store.id(runId);
    store.create({ protocol: 1, id, runId, routineId: `rt${runId}`, directory: store.directory,
      release: root, node: process.execPath, cwd: root, worktreePath: root, script: { command, timeoutSeconds } });
    return id;
  };
  const launch = (id: string) => {
    const child = spawn(binary, ["routine-host", store.directory, id], { stdio: "ignore" }); hosts.push(child); return child;
  };
  const finished = async (id: string, child: ChildProcess) => {
    await until(() => child.exitCode !== null || child.signalCode !== null, "native host completion");
    assert.equal(child.exitCode, 0); const result = store.result(id); assert(result); return result;
  };
  return { root, store, create, launch, finished };
}

test("native routine host preserves output, exit status, bounds, and exclusive invocation", async t => {
  const f = fixture(t);
  const id = f.create("printf '안녕하세요'; printf stderr >&2; exit 7");
  const result = await f.finished(id, f.launch(id));
  assert.equal(result.status, "failed"); assert.equal(result.exitCode, 7);
  assert.match(result.output!, /안녕하세요/); assert.match(result.output!, /stderr/);
  assert.equal(result.worktreePath, f.root);
  const large = f.create("head -c 100000 /dev/zero | tr '\\0' x");
  const capped = await f.finished(large, f.launch(large));
  assert.equal(capped.status, "succeeded");
  assert.equal(capped.output, "x".repeat(65536) + "\n[output truncated]");
  const once = f.create("echo once >> once; while [ ! -f finish ]; do sleep 0.05; done");
  const first = f.launch(once), second = f.launch(once);
  await until(() => existsSync(join(f.root, "once")), "exclusive script starts");
  writeFileSync(join(f.root, "finish"), "");
  await until(() => first.exitCode !== null && second.exitCode !== null, "both claim contenders exit");
  await f.finished(once, first); await f.finished(once, second);
  const prior = f.store.result(once);
  await f.finished(once, f.launch(once));
  assert.deepEqual(f.store.result(once), prior);
  assert.equal(readFileSync(join(f.root, "once"), "utf8"), "once\n");
});

test("native routine host observes pre-launch cancellation, stop files, signals, and timeout", async t => {
  const f = fixture(t);
  const prior = f.create("touch forbidden"); f.store.stop(prior, "interrupted before launch");
  assert.equal((await f.finished(prior, f.launch(prior))).status, "interrupted");
  assert(!existsSync(join(f.root, "forbidden")));
  for (const method of ["stop", "signal", "timeout"] as const) {
    const marker = `started-${method}`;
    const id = f.create(`sleep 30 & echo $! > ${marker}; wait`, method === "timeout" ? 1 : 10);
    const host = f.launch(id);
    await until(() => existsSync(join(f.root, marker)), "script descendant starts");
    const descendant = Number(readFileSync(join(f.root, marker), "utf8"));
    if (method === "stop") f.store.stop(id, "interrupted by user");
    if (method === "signal") host.kill("SIGTERM");
    const result = await f.finished(id, host);
    assert.equal(result.status, method === "timeout" ? "failed" : "interrupted");
    assert.match(result.note!, method === "timeout" ? /timed out/ : /interrupted/);
    await until(() => !running(descendant), "script descendant is stopped");
  }
});

test("native watchdog lease terminates descendants after abrupt host death without replay", async t => {
  const f = fixture(t);
  const id = f.create("echo once >> invocations; sleep 30 & echo $! > child; wait");
  const host = f.launch(id);
  await until(() => existsSync(join(f.root, "child")), "descendant starts");
  const descendant = Number(readFileSync(join(f.root, "child"), "utf8"));
  host.kill("SIGKILL");
  await until(() => !running(descendant), "watchdog lease kills orphaned script");
  const duplicate = f.launch(id);
  await until(() => duplicate.exitCode !== null, "claimed invocation is not replayed");
  assert.equal(duplicate.exitCode, 0); assert.equal(f.store.result(id), undefined);
  assert.equal(readFileSync(join(f.root, "invocations"), "utf8"), "once\n");
});

test("native routine completion survives unavailable result storage without rerunning", async t => {
  const f = fixture(t), id = f.create("echo once >> invocations; printf durable");
  const blocked = join(f.store.directory, `${id}.result`); mkdirSync(blocked);
  const host = f.launch(id);
  await until(() => existsSync(join(f.root, "invocations")), "script finishes before storage recovery");
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(host.exitCode, null);
  const recoveredAt = Date.now();
  rmSync(blocked, { recursive: true });
  const result = await f.finished(id, host);
  assert.equal(result.output, "durable"); assert(result.finishedAt! < recoveredAt);
  assert.equal(readFileSync(join(f.root, "invocations"), "utf8"), "once\n");
});

test("native host rejects a mismatched descriptor before claiming or executing it", async t => {
  const f = fixture(t), id = f.create("touch forbidden");
  const path = join(f.store.directory, `${id}.json`);
  const descriptor = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...descriptor, runId: 99 }), { mode: 0o600 });
  const host = f.launch(id);
  await until(() => host.exitCode !== null, "invalid descriptor is rejected");
  assert.notEqual(host.exitCode, 0);
  assert(!existsSync(join(f.store.directory, `${id}.claim`)));
  assert(!existsSync(join(f.root, "forbidden")));
});

test("native host bounds draining of pipe descriptors retained outside the script group", async t => {
  const f = fixture(t);
  const id = f.create("setsid sh -c 'echo $$ > escaped; sleep 30' & while [ ! -f escaped ]; do sleep 0.01; done; printf done");
  const host = f.launch(id);
  await until(() => existsSync(join(f.root, "escaped")), "escaped fixture descendant starts");
  const escaped = Number(readFileSync(join(f.root, "escaped"), "utf8"));
  // Real installations have a cgroup guardian; this direct-host fixture cleans its own escaped group.
  t.after(() => { try { process.kill(-escaped, "SIGKILL"); } catch {} });
  const result = await f.finished(id, host);
  assert.equal(result.status, "succeeded"); assert.equal(result.output, "done");
});
