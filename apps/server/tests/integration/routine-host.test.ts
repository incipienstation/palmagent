import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { Db } from "../../src/composition/database.js";
import { RoutineService } from "../../src/modules/routines/application/use-cases/routine-service.js";
import { DaemonRoutineScriptRunner } from "../../src/modules/routines/adapters/outbound/daemon-script-runner.js";
import { RoutineHostStore } from "../../src/modules/routines/adapters/outbound/routine-host-store.js";
import { WorktreeManager } from "../../src/modules/spaces/adapters/outbound/worktree.js";
import { NodeIdentifierGenerator } from "../../src/platform/process/id-generator.js";
import { daemonRequest } from "../../src/platform/process/daemon-client.js";
import { Hub } from "../../src/platform/events/hub.js";
import type { RoutineTaskUseCases } from "../../src/modules/routines/application/ports/outbound/routines.js";
import { createReleaseOperations } from "../../src/modules/installation/adapters/outbound/execution-release.js";
import type { InstallConfig } from "../../src/modules/installation/adapters/outbound/config.js";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
async function until(predicate: () => unknown | Promise<unknown>, label: string) {
  for (let i = 0; i < 400; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

test("daemon routine hosts preserve admission and results through web detach, replacement and cancellation", { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "routine-host-test-"));
  const release = join(root, "releases/first");
  for (const directory of ["daemon", "releases/first", "runtimes", "repo"]) mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
  const sourceBinary = join(repository, "target/debug/palmagentd");
  assert(existsSync(sourceBinary), "Run daemon:check before server contracts");
  const binary = join(release, "palmagentd");
  copyFileSync(sourceBinary, binary);
  copyFileSync(binary, join(root, "daemon/launcher"));
  copyFileSync(process.execPath, join(root, "runtimes/node"));
  const node = join(root, "runtimes/node");
  writeFileSync(join(release, "package.json"), '{"type":"module"}');
  writeFileSync(join(release, "server.js"), "setInterval(() => {}, 1000);\n");
  buildSync({ entryPoints: [join(repository, "apps/server/src/bootstrap/routine-host.ts")], outfile: join(release, "routine-host.js"), bundle: true, platform: "node", format: "esm", target: "node24" });
  writeFileSync(join(root, "daemon/config.json"), JSON.stringify({ protocol: 1, daemon: binary, release, node,
    environment: { PATH: process.env.PATH }, isolation: "process-group",
    limits: { memoryHigh: 1024, memoryMax: 2048, tasks: 64, webTasks: 64, cpuPercent: 100, nofile: 1024 } }), { mode: 0o600 });
  const daemon = spawn(binary, ["serve", "--data-dir", root], { stdio: "ignore" });
  const request = (action: "status" | "replace" | "restart-web" | "stop") => daemonRequest(root, { action });
  let db = new Db(join(root, "state.db"));
  db.insertRepo({ id: "space", name: "test", path: join(root, "repo"), vcs: "none", defaultBaseRef: "HEAD", createdAt: 1 });
  const tasks = { updating: false, createTask() { throw new Error("Scripts must not invoke an agent"); } } as unknown as RoutineTaskUseCases;
  const makeService = () => new RoutineService(db, tasks, new NodeIdentifierGenerator(),
    new DaemonRoutineScriptRunner(root, release, node, new WorktreeManager()), new Hub());
  let service = makeService();
  const store = new RoutineHostStore(join(root, "routines"));
  t.after(async () => {
    await service.stop();
    for (const descriptor of store.list()) store.stop(descriptor.id, "interrupted by test cleanup");
    await until(async () => { try { await request("stop"); return true; } catch { return false; } }, "fixture hosts stop");
    daemon.kill();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  await until(async () => { try { return await request("status"); } catch { return false; } }, "daemon startup");
  service.start();
  const create = (command: string, timeoutSeconds = 30) => service.create({ repoId: "space", kind: "script", script: { command, timeoutSeconds }, preset: "manual" });
  const finished = async (id: string) => {
    await until(() => service.runs(id)[0]?.status !== "running", "script result");
    return service.runs(id)[0];
  };
  const routine = create("echo $$ > pid; echo once >> invocations; while [ ! -f release ]; do sleep 0.1; done; printf complete");
  service.runNow(routine.id);
  await until(() => existsSync(join(root, "repo/pid")), "script starts");
  const pid = Number(readFileSync(join(root, "repo/pid"), "utf8"));
  assert.equal(service.activeScriptCount, 1);
  assert.equal(service.updateBlockingScriptCount, 0);
  await service.stop(); db.close();
  await request("replace");
  await until(async () => { try { return await request("status"); } catch { return false; } }, "replacement daemon");
  await request("restart-web");
  process.kill(pid, 0);
  db = new Db(join(root, "state.db")); service = makeService(); service.start();
  assert.throws(() => service.runNow(routine.id), /already running/);
  assert.throws(() => service.remove(routine.id), /running script/);
  writeFileSync(join(root, "repo/release"), "");
  const run = await finished(routine.id);
  assert.equal(run.status, "succeeded"); assert.equal(run.output, "complete");
  assert.equal(readFileSync(join(root, "repo/invocations"), "utf8"), "once\n");
  assert(store.recorded(store.id(run.id)));

  const controlSocket = `/tmp/palmagentd-${process.getuid!()}-${createHash("sha256").update(root).digest("hex").slice(0, 20)}/control.sock`;
  // Control-plane uncertainty retains admission, even if the script finishes meanwhile.
  const unavailable = create("echo ready > unavailable-ready; while [ ! -f unavailable-release ]; do sleep 0.1; done; printf recovered");
  service.runNow(unavailable.id);
  await until(() => existsSync(join(root, "repo/unavailable-ready")), "uncertain host starts");
  renameSync(controlSocket, controlSocket + ".offline");
  try {
    writeFileSync(join(root, "repo/unavailable-release"), "");
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(service.runs(unavailable.id)[0].status, "running");
    assert.throws(() => service.runNow(unavailable.id), /already running/);
  } finally { renameSync(controlSocket + ".offline", controlSocket); }
  assert.equal((await finished(unavailable.id)).output, "recovered");

  // Completion during web downtime is recovered from the host's durable result.
  const offline = create("while [ ! -f offline-release ]; do sleep 0.1; done; printf offline");
  service.runNow(offline.id);
  const offlineRun = service.runs(offline.id)[0];
  await until(() => existsSync(join(root, "routines", store.id(offlineRun.id) + ".claim")), "offline host starts");
  await service.stop(); db.close();
  writeFileSync(join(root, "repo/offline-release"), "");
  await until(() => store.result(store.id(offlineRun.id)), "offline result is durable");
  db = new Db(join(root, "state.db")); service = makeService(); service.start();
  assert.equal((await finished(offline.id)).output, "offline");

  const storage = create("echo once >> storage-invocations; printf durable");
  const finishRun = db.finishRoutineRun;
  const failure = t.mock.method(db, "finishRoutineRun", (id: number, result: Parameters<Db["finishRoutineRun"]>[1]) => {
    if (result.status !== "running") throw new Error("Fixture storage unavailable");
    return finishRun(id, result);
  });
  service.runNow(storage.id);
  await until(() => failure.mock.callCount() >= 2, "completed result awaits database recovery");
  assert.throws(() => service.runNow(storage.id), /already running/);
  assert.throws(() => service.remove(storage.id), /running script/);
  await assert.rejects(service.stop(), /could not be persisted/);
  failure.mock.restore(); db.close();
  db = new Db(join(root, "state.db")); service = makeService(); service.start();
  assert.equal((await finished(storage.id)).output, "durable");
  assert.equal(readFileSync(join(root, "repo/storage-invocations"), "utf8"), "once\n");

  const timed = create("(sleep 3; touch escaped-timeout) & wait", 1);
  service.runNow(timed.id);
  const timedResult = await finished(timed.id);
  assert.equal(timedResult.status, "failed"); assert.match(timedResult.note!, /timed out/);
  const cancelled = create("(sleep 3; touch escaped-cancel) & wait");
  service.runNow(cancelled.id);
  await service.stopRun(cancelled.id);
  assert.equal(service.runs(cancelled.id)[0].status, "interrupted");
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert(!existsSync(join(root, "repo/escaped-timeout")));
  assert(!existsSync(join(root, "repo/escaped-cancel")));

  const output = create("head -c 100000 /dev/zero | tr '\\0' x; exit 7");
  service.runNow(output.id);
  const bounded = await finished(output.id);
  assert.equal(bounded.exitCode, 7); assert.equal(bounded.status, "failed");
  assert(bounded.output!.length < 66000); assert.match(bounded.output!, /truncated/);

  const gitRepo = join(root, "git-repo"); mkdirSync(gitRepo);
  execFileSync("git", ["init", "-q", gitRepo]);
  execFileSync("git", ["-C", gitRepo, "-c", "user.name=Test", "-c", "user.email=validation", "commit", "--allow-empty", "-qm", "init"]);
  db.insertRepo({ id: "git-space", name: "git", path: gitRepo, vcs: "git", defaultBaseRef: "HEAD", createdAt: 1 });
  const isolated = service.create({ repoId: "git-space", kind: "script", script: { command: "printf report > report.txt", timeoutSeconds: 5 }, preset: "manual" });
  service.runNow(isolated.id);
  const isolatedRun = await finished(isolated.id);
  assert.equal(isolatedRun.status, "succeeded"); assert(isolatedRun.worktreePath);
  assert.equal(readFileSync(join(isolatedRun.worktreePath, "report.txt"), "utf8"), "report");
  assert(!existsSync(join(gitRepo, "report.txt")));

  // A committed admission without a confirmed launch is interrupted, never replayed.
  const uncertain = create("touch must-not-run");
  db.insertRoutineRun({ routineId: uncertain.id, firedAt: Date.now(), status: "running" });
  db.insertRoutineRun({ routineId: uncertain.id, firedAt: Date.now(), status: "running" });
  await service.stop(); service = makeService(); service.start();
  await until(() => service.runs(uncertain.id).every(run => run.status === "interrupted"), "all unconfirmed admissions recover without replay");
  assert(!existsSync(join(root, "repo/must-not-run")));
  assert(readdirSync(join(root, "daemon/hosts")).some(name => name.startsWith("routine-")));
});

test("release compatibility retains unrecorded routine results and rejects incompatible candidates", t => {
  const root = mkdtempSync(join(tmpdir(), "routine-retention-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = join(root, "release"); mkdirSync(release);
  for (const file of ["cli.js", "server.js", "execution-host.js", "execution-launcher.js", "routine-host.js"]) writeFileSync(join(release, file), "");
  const contract = { executionProtocol: 1, productStorage: 1, applicationApi: 1 };
  writeFileSync(join(release, "runtime-contract.json"), JSON.stringify(contract));
  const store = new RoutineHostStore(join(root, "routines"));
  store.create({ protocol: 1, id: "1", runId: 1, routineId: "rt1", directory: store.directory,
    release, node: process.execPath, cwd: root, script: { command: "true", timeoutSeconds: 1 } });
  assert.throws(() => store.create({ ...store.get("1")!, script: { command: "false", timeoutSeconds: 1 } }), { code: "EEXIST" });
  assert.equal(store.get("1")!.script.command, "true");
  const releases = createReleaseOperations({
    executions() { throw new Error("No executions exist"); }, terminals() { throw new Error("No terminals exist"); },
    routines: () => store.list().filter(row => !store.recorded(row.id)).map(row => ({ ...row, state: "running" })),
  });
  const cfg = { dataDir: root, pkgDir: release, executionNode: process.execPath } as InstallConfig;
  assert.throws(() => releases.verifyActiveExecutionCompatibility(cfg), /retained routine/);
  assert.throws(() => releases.assertExecutionsFinished(cfg), /Routine scripts/);
  store.finish("1", { status: "succeeded", finishedAt: Date.now(), output: "done" });
  assert.throws(() => releases.verifyActiveExecutionCompatibility(cfg), /retained routine/, "A result not yet copied into run history needs recovery support");
  writeFileSync(join(release, "runtime-contract.json"), JSON.stringify({ ...contract, routineProtocol: 1 }));
  releases.verifyActiveExecutionCompatibility(cfg);
  store.acknowledge("1");
  writeFileSync(join(release, "runtime-contract.json"), JSON.stringify(contract));
  releases.verifyActiveExecutionCompatibility(cfg); releases.assertExecutionsFinished(cfg);
});
