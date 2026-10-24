import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { Db } from "../../src/composition/database.js";
import { NativeScriptRuntime } from "../../src/modules/routines/adapters/outbound/native-script-runtime.js";
import { daemonRequest } from "../../src/platform/process/daemon-client.js";
import { DaemonStatusSchema } from "@palmagent/shared/daemon";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
async function until(predicate: () => unknown | Promise<unknown>, label: string) {
  for (let i = 0; i < 800; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

test("native scripts schedule and persist without web, recover without replay, and hand off on rollback", { timeout: 90_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "native-script-test-"));
  const release = join(root, "releases/first");
  const artifact = join(release, `daemon/${process.platform}-${process.arch}`);
  for (const directory of ["daemon", "runtimes", "repo", `releases/first/daemon/${process.platform}-${process.arch}`]) mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
  const binary = join(artifact, "palmagentd");
  for (const name of ["palmagentd", "palmagent-runtime"]) copyFileSync(join(repository, "target/debug", name), join(artifact, name));
  copyFileSync(binary, join(root, "daemon/launcher"));
  const node = join(root, "runtimes/node"); copyFileSync(process.execPath, node);
  const version = JSON.parse(execFileSync(join(artifact, "palmagent-runtime"), ["version"], { encoding: "utf8" }));
  writeFileSync(join(release, "daemon/manifest.json"), JSON.stringify({ ...version, applicationRuntime: 1, hostReadiness: 1 }));
  writeFileSync(join(release, "package.json"), '{"type":"module"}');
  buildSync({ stdin: { contents: `
    import { NativeScriptRuntime } from ${JSON.stringify(join(repository, "apps/server/src/modules/routines/adapters/outbound/native-script-runtime.ts"))};
    import { createHostReadiness } from ${JSON.stringify(join(repository, "apps/server/src/platform/process/host-readiness.ts"))};
    const ready = createHostReadiness();
    await new NativeScriptRuntime(${JSON.stringify(root)}).connect(${JSON.stringify(release)});
    ready(); setInterval(() => {}, 1000);
  `, resolveDir: repository, loader: "ts" }, outfile: join(release, "server.js"), bundle: true, platform: "node", format: "esm", target: "node24" });
  buildSync({ entryPoints: [join(repository, "apps/server/src/bootstrap/routine-host.ts")], outfile: join(release, "routine-host.js"), bundle: true, platform: "node", format: "esm", target: "node24" });
  const config = { protocol: 1, daemon: binary, release, node,
    environment: { PATH: process.env.PATH }, isolation: "process-group",
    limits: { memoryHigh: 1024, memoryMax: 2048, tasks: 64, webTasks: 64, cpuPercent: 100, nofile: 1024 } };
  writeFileSync(join(root, "daemon/config.json"), JSON.stringify(config), { mode: 0o600 });
  const db = new Db(join(root, "palmagent.db"));
  db.insertRepo({ id: "space", name: "test", path: join(root, "repo"), vcs: "none", defaultBaseRef: "HEAD", createdAt: 1 });
  const daemon = spawn(binary, ["serve", "--data-dir", root], { stdio: "ignore" });
  const status = async () => DaemonStatusSchema.parse(await daemonRequest(root, { action: "status" }));
  t.after(async () => {
    try { await daemonRequest(root, { action: "stop" }); } finally { daemon.kill(); db.close(); rmSync(root, { recursive: true, force: true }); }
  });
  await until(async () => { try { return await status(); } catch { return false; } }, "daemon startup");
  const native = new NativeScriptRuntime(root);
  try { await native.connect(release); } catch (error) {
    console.error(await status());
    for (const name of readdirSync(join(root, "daemon/logs"))) console.error(name, readFileSync(join(root, "daemon/logs", name), "utf8"));
    throw error;
  }
  const create = (command: string, preset: "manual" | "hourly" = "manual") => native.create({ repoId: "space", kind: "script", script: { command, timeoutSeconds: 20 }, preset });
  const finished = async (id: string) => {
    await until(async () => (await native.runs(id))[0]?.status !== "running", "completion persisted");
    return (await native.runs(id))[0];
  };
  // No web application code runs in this fixture: the placeholder web process can
  // be suspended while native admission, scheduling and completion remain active.
  await until(async () => (await status()).web?.lifecycle?.readiness === "ready", "web bootstrap readiness");
  const web = (await status()).web!;
  process.kill(z.object({ pid: z.number().int().positive() }).parse(web.child).pid, "SIGSTOP");
  const scheduled = await create("printf scheduled", "hourly");
  db.updateRoutine({ ...scheduled, nextRunAt: Date.now() - 1 });
  await until(async () => (await native.runs(scheduled.id)).length, "scheduled admission without web");
  assert.equal((await finished(scheduled.id)).output, "scheduled");
  process.kill(z.object({ pid: z.number().int().positive() }).parse(web.child).pid, "SIGCONT");

  const held = await create("echo once >> invocations; touch started; while [ ! -f finish ]; do sleep 0.1; done; printf retained");
  await native.run(held.id);
  await until(() => existsSync(join(root, "repo/started")), "script started");
  await assert.rejects(native.run(held.id), /already running/);
  await assert.rejects(native.remove(held.id), /running/);
  const before = await native.status();
  const application = (await status()).application!;
  process.kill(z.object({ pid: z.number().int().positive() }).parse(application.child).pid, "SIGKILL");
  await until(async () => { try { return (await native.status()).instance !== before.instance; } catch { return false; } }, "native recovery");
  writeFileSync(join(root, "repo/finish"), "");
  assert.equal((await finished(held.id)).output, "retained");
  assert.equal(readFileSync(join(root, "repo/invocations"), "utf8"), "once\n");
  const recovered = await native.status();
  await daemonRequest(root, { action: "replace" });
  await until(async () => { try { return await status(); } catch { return false; } }, "daemon replacement");
  assert.equal((await native.status()).instance, recovered.instance);
  await daemonRequest(root, { action: "restart-web" });
  assert.equal((await native.status()).instance, recovered.instance);
  assert(!(await daemonRequest(root, { action: "list" }) as { hosts: { kind: string }[] }).hosts.some(h => h.kind === "application"));

  const cancelled = await create("sleep 10; touch must-not-run");
  await native.run(cancelled.id);
  await native.stop(cancelled.id);
  assert.equal((await native.runs(cancelled.id))[0].status, "interrupted");
  assert(!existsSync(join(root, "repo/must-not-run")));
  const changed = await native.update(held.id, { title: "updated", script: { command: "printf changed" } });
  assert.equal(changed.script!.timeoutSeconds, 20);
  assert.equal((await native.list()).find(r => r.id === held.id)?.title, "updated");

  // Selecting a pre-capability release stops the sole native writer before its
  // older web can resume the legacy scheduler. Retained script hosts survive.
  const rollback = join(root, "releases/legacy"); mkdirSync(rollback, { mode: 0o700 });
  writeFileSync(join(rollback, "server.js"), "setInterval(() => {}, 1000);\n");
  writeFileSync(join(root, "daemon/config.json"), JSON.stringify({ ...config, release: rollback }), { mode: 0o600 });
  await daemonRequest(root, { action: "restart-web" });
  await assert.rejects(native.status());
  assert.equal((await status()).application?.alive, false);
});
