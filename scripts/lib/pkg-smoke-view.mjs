import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, smokeEnv } from "./pkg-smoke-runtime.mjs";

// The installed tarball must work under the actual daemon, not only `start`.
// Source lifecycle tests cover auth/SSE policy; this covers retained package paths,
// view restart, queue progress and the daemon's recovery of the API owner.
export async function smokeRetainedView(pkgDir, scratch, parent, inspect) {
  const root = join(scratch, "retained");
  const data = join(root, "data"), release = join(data, "releases/fixture");
  for (const path of [root, data, release, join(data, "daemon"), join(data, "runtimes"),
    ...["home", "cache", "tmp", "bin", "repo", "control"].map(part => join(root, part))]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  cpSync(pkgDir, release, { recursive: true });
  symlinkSync(join(scratch, "node_modules"), join(release, "node_modules"));
  const node = join(data, "runtimes/node");
  copyFileSync(process.execPath, node);
  const port = await freePort();
  const env = { ...smokeEnv(parent, root, port), PATH: join(root, "bin") + ":" + dirname(node) + ":/usr/bin:/bin",
    PALMAGENT_HOME: join(root, "home/.palmagent"), STATIC_DIR: join(release, "web"),
    EXECUTION_RELEASE: release, EXECUTION_NODE: node, REPO_ROOTS: join(root, "repo"),
    PROBE_CONTROL: join(root, "control"), DISPATCH_CONCURRENCY: "2", PALMAGENT_EXECUTION_CONCURRENCY: "2" };
  const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../../apps/server/tests/support/lifecycle-cli.cjs");
  for (const agent of ["codex", "claude"]) writeFileSync(join(root, "bin", agent),
    `#!${node}\nprocess.argv.splice(1, 1, ${JSON.stringify(fixture)}, ${JSON.stringify(agent)}); require(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
  execFileSync("git", ["init", "-b", "main"], { cwd: join(root, "repo"), env, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Validation", "-c", "user.email=validation", "commit", "--allow-empty", "-m", "Synthetic fixture"],
    { cwd: join(root, "repo"), env, stdio: "ignore" });
  const daemon = join(release, "daemon", `${process.platform}-${process.arch}`, "palmagentd");
  writeFileSync(join(data, "daemon/config.json"), JSON.stringify({ protocol: 1, daemon, release, node, environment: env,
    isolation: "process-group", limits: { memoryHigh: 1073741824, memoryMax: 2147483648, tasks: 256, webTasks: 128, cpuPercent: 100, nofile: 65536 } }), { mode: 0o600 });
  const child = spawn(daemon, ["serve", "--data-dir", data], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { logs = (logs + chunk).slice(-16000); });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const command = request => JSON.parse(execFileSync(daemon, ["request", "--data-dir", data],
    { cwd: root, env, input: JSON.stringify(request), encoding: "utf8", timeout: 40000, stdio: ["pipe", "pipe", "pipe"] }));
  const view = action => JSON.parse(execFileSync(node, [join(release, "cli.js"), "view", action, "--data-dir", data],
    { cwd: root, env, encoding: "utf8", timeout: 25000, stdio: ["ignore", "pipe", "pipe"] }));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, logs);
      const value = await predicate(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${label}\n${logs}`);
  };
  const base = `http://localhost:${port}`;
  const api = async (path, body) => {
    const response = await fetch(base + "/api/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
  };
  const mark = (key, suffix) => writeFileSync(join(root, "control", key + suffix), "");
  let taskId, paused;
  try {
    await until("packaged API readiness", async () => {
      try { return (await api("health")).ok; } catch { return false; }
    });
    const before = view("status");
    assert.equal(before.state, "ready");
    assert.equal(command({ action: "status" }).web.child.pid, before.ownerPid);
    const shell = await (await fetch(base)).text();
    assert(shell.includes('<div id="root"'));
    const repo = (await api("repos", { path: join(root, "repo"), defaultBaseRef: "main" })).repo;
    const task = (await api("tasks", { repoId: repo.id, agent: "codex", isolate: true,
      prompt: JSON.stringify({ key: "packed-a", mode: "hold" }) })).task;
    taskId = task.taskId;
    await until("packaged provider starts", () => existsSync(join(root, "control/packed-a.ready")));
    await api(`tasks/${taskId}/messages`, { clientMessageId: crypto.randomUUID(), mode: "queue", expectedRunId: null,
      text: JSON.stringify({ key: "packed-b", mode: "auto" }) });
    paused = before.pid; process.kill(paused, "SIGSTOP");
    await assert.rejects(fetch(base, { signal: AbortSignal.timeout(100) }));
    mark("packed-a", ".release");
    await until("packaged queue advances during view stall", () => existsSync(join(root, "control/packed-b.ready")));
    await api(`tasks/${taskId}/messages`, { clientMessageId: crypto.randomUUID(), mode: "queue", expectedRunId: null,
      text: JSON.stringify({ key: "packed-c", mode: "auto" }) });
    await until("packaged admission during view stall", () => existsSync(join(root, "control/packed-c.ready")));
    const next = view("restart"); paused = undefined;
    assert.equal(next.ownerPid, before.ownerPid); assert.notEqual(next.pid, before.pid);
    assert.equal(await (await fetch(base)).text(), shell);
    await until("packaged Task becomes idle", async () => (await api(`tasks/${taskId}`)).task.status === "idle");
    if (inspect) await inspect({ base, view, taskId, api });
    process.kill(next.ownerPid, "SIGKILL");
    const recovered = await until("daemon recovers API owner", async () => {
      try { const state = view("status"); return state.state === "ready" && state.ownerPid !== next.ownerPid && state; }
      catch { return false; }
    });
    assert.equal(command({ action: "status" }).web.child.pid, recovered.ownerPid);
    assert.equal((await api(`tasks/${taskId}`)).task.status, "idle");
    assert.equal(await (await fetch(base)).text(), shell);
    console.log("[smoke] packaged retained API: stalled-view queue/admission, view restart, daemon owner recovery passed");
  } finally {
    if (paused) { try { process.kill(paused, "SIGCONT"); } catch {} }
    if (taskId) { try { await api(`tasks/${taskId}/stop`, {}); } catch {} }
    // Stop any owned active provider hosts before the supervisor can shut down.
    const hosts = join(data, "daemon/hosts");
    for (const name of existsSync(hosts) ? readdirSync(hosts).filter(name => name.endsWith(".json")) : []) {
      const record = JSON.parse(readFileSync(join(hosts, name), "utf8"));
      if (!["execution", "terminal", "routine", "update"].includes(record.kind)) continue;
      try { command({ action: "terminate", kind: record.kind, id: record.id }); } catch {}
    }
    try { command({ action: "stop" }); }
    finally {
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited; clearTimeout(force);
      // A failed stop must not leave detached guardians after scratch removal.
      // Match start identity before signaling only this fixture's recorded hosts.
      const signalOwned = (identity, group) => {
        if (!identity) return;
        try {
          const stat = readFileSync(`/proc/${identity.pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
          const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
          if (`${boot}:${fields[19]}` === identity.start && !["Z", "X"].includes(fields[0])) {
            process.kill(group ? -identity.pid : identity.pid, "SIGKILL");
          }
        } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
      };
      for (const name of existsSync(hosts) ? readdirSync(hosts).filter(name => name.endsWith(".json")) : []) {
        const path = join(hosts, name);
        signalOwned(JSON.parse(readFileSync(path, "utf8")).guard, false);
        signalOwned(JSON.parse(readFileSync(path, "utf8")).child, true);
      }
      const socketRoot = join("/tmp", `palmagentd-${process.getuid()}-${createHash("sha256").update(data).digest("hex").slice(0, 20)}`);
      rmSync(socketRoot, { recursive: true, force: true });
    }
  }
}
