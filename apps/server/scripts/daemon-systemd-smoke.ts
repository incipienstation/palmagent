/** Packed Linux acceptance: a unique delegated bootstrap, real fixture providers,
 * daemon replacement/crash, persistent terminal, and cgroup descendant cleanup.
 * Never modifies the installed Palmagent service or uses authenticated providers. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { DEFAULT_CAPS, type InstallConfig } from "../src/modules/installation/adapters/outbound/config.js";
import { installDaemonBootstrap, removeDaemonBootstrap, startDaemonBootstrap } from "../src/modules/installation/adapters/outbound/daemon-bootstrap.js";
import { daemonServiceName, prepareUserService, userServiceDirectory, userServiceEnvironment, verifyUserIsolation } from "../src/modules/installation/adapters/outbound/user-service.js";
import { daemonBinary, writeDaemonConfiguration } from "../src/modules/installation/adapters/outbound/daemon-runtime.js";
import { daemonRequest } from "../src/platform/process/daemon-client.js";
import { DaemonStatusSchema } from "@palmagent/shared/daemon";
import { pinNode } from "../src/modules/installation/adapters/outbound/execution-release.js";
import { ExecutionStore } from "../src/modules/agents/adapters/outbound/execution-store.js";
import { TerminalStore } from "../src/modules/terminals/adapters/outbound/sqlite-terminal-store.js";
import { unixTransport } from "../src/modules/terminals/adapters/outbound/linux.js";
import type { TerminalFrame } from "@palmagent/shared/terminals";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const artifact = resolve(process.argv[2] ?? join(repository, "build/pkg"));
assert(existsSync(join(artifact, "daemon/manifest.json")), "Build the native package before acceptance");
const systemScope = process.argv.includes("--system");
if (systemScope) execFileSync("sudo", ["-n", "true"], { stdio: "pipe" });
const root = mkdtempSync(join(tmpdir(), "palmagentd-acceptance-"));
const dataDir = join(root, "data");
let unit = `palmagentd-test-${randomUUID().replaceAll("-", "")}.service`;
const admin = (...args: string[]) => execFileSync("/usr/bin/sudo", ["-n", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const until = async (predicate: () => unknown | Promise<unknown>, label: string) => {
  for (let i = 0; i < 600; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
};
let executions: ExecutionStore | undefined, terminals: TerminalStore | undefined;
let terminalChannel: Awaited<ReturnType<typeof unixTransport.connect>> | undefined;
let cgroup: string | undefined;
let cleanupConfirmed = false;
let installed: InstallConfig | undefined;
const originalEnvironment = { ...process.env };
try {
  for (const directory of ["home", "control", "bin", "repo", "data/daemon", "data/releases/first"]) mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", root], { cwd: artifact, encoding: "utf8" }));
  const prefix = join(dataDir, "releases/first");
  execFileSync("npm", ["install", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund", join(root, packed[0].filename)], { stdio: "pipe" });
  const release = join(prefix, "node_modules/palmagent");
  const node = pinNode(dataDir);
  const binary = daemonBinary(release);
  // Keep a deliberately unusable old launcher: direct control must not invoke it.
  writeFileSync(join(dataDir, "daemon/launcher"), "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  const providerFixture = join(repository, "apps/server/tests/support/lifecycle-cli.cjs");
  for (const agent of ["claude", "codex"]) writeFileSync(join(root, "bin", agent), `#!${process.execPath}\nprocess.argv.splice(2,0,${JSON.stringify(agent)}); require(${JSON.stringify(providerFixture)});\n`, { mode: 0o700 });
  // Any runtime use of privileged service management fails this acceptance run.
  for (const name of ["sudo", "systemctl"]) writeFileSync(join(root, "bin", name), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(root, "forbidden-service-call"))}, 'called'); process.exit(97);\n`, { mode: 0o700 });
  execFileSync("git", ["init", "-b", "main"], { cwd: join(root, "repo"), stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=Validation", "-c", "user.email=validation", "commit", "--allow-empty", "-m", "Fixture"], { cwd: join(root, "repo"), stdio: "pipe" });
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "localhost", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const config = {
    protocol: 1, daemon: binary, release, node, isolation: "cgroup",
    limits: { memoryHigh: 1024 ** 3, memoryMax: 2 * 1024 ** 3, tasks: 256, webTasks: 256, cpuPercent: 100, nofile: 65536 },
    environment: { HOME: join(root, "home"), USER: userInfo().username, LOGNAME: userInfo().username,
      PATH: `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`, NODE_ENV: "development", AUTH_DISABLED: "1", HOST: "localhost", PORT: String(port),
      PROBE_CONTROL: join(root, "control"), PALMAGENT_HOME: join(root, "home/preferences"),
      DISPATCH_CONCURRENCY: "2", PALMAGENT_EXECUTION_CONCURRENCY: "2", DISPATCHER_DATA_DIR: dataDir,
      DISPATCHER_DB: join(dataDir, "dispatcher.db"), REPO_ROOTS: join(root, "repo"), EXECUTION_RELEASE: release, EXECUTION_NODE: node, STATIC_DIR: join(release, "web") },
  };
  const save = () => writeDaemonConfiguration(dataDir, config);
  save();
  if (systemScope) {
  admin("systemd-run", "--quiet", "--collect", `--unit=${unit}`, `--uid=${userInfo().username}`,
    "--property=Delegate=cpu memory pids", "--property=DelegateSubgroup=control", "--property=KillMode=process", "--property=Restart=on-failure", "--property=RestartSec=1",
    "--property=LimitNOFILE=65536", "--property=TasksMax=infinity", binary, "serve", "--data-dir", dataDir);
    cgroup = admin("systemctl", "show", unit, "--property=ControlGroup", "--value").trim();
  } else {
    const installerBin = join(root, "installer-bin");
    mkdirSync(installerBin);
    copyFileSync(join(root, "bin/sudo"), join(installerBin, "sudo"));
    process.env.PATH = installerBin + ":" + process.env.PATH;
    installed = {
      mode: "package", supervisor: "palmagentd", daemonScope: "user", daemonUnitDir: userServiceDirectory(),
      user: userInfo().username, group: userInfo().username, dataDir, pkgDir: release, workingDir: release,
      executionNode: node, execPath: config.environment.PATH, runnerSocket: join(dataDir, "runner.sock"),
      dbPath: config.environment.DISPATCHER_DB, host: "localhost", port, domain: "palmagent.example.com",
      concurrency: 2, rpId: "palmagent.example.com", rpName: "Palmagent", authOrigin: "https://palmagent.example.com",
      caps: DEFAULT_CAPS, pushSubject: "", repoRoots: join(root, "repo"), claudeConfigDir: "",
    };
    unit = daemonServiceName(installed);
    prepareUserService(installed);
    verifyUserIsolation(installed);
    installDaemonBootstrap(installed);
    startDaemonBootstrap(installed);
    cgroup = execFileSync("/usr/bin/systemctl", ["--user", "show", unit, "--property=ControlGroup", "--value"], { encoding: "utf8", env: userServiceEnvironment() }).trim();
    assert(cgroup.includes(`/user@${process.getuid!()}.service/`));
    assert.equal(execFileSync("/usr/bin/systemctl", ["--user", "is-enabled", unit], { encoding: "utf8", env: userServiceEnvironment() }).trim(), "enabled");
  }
  assert(cgroup.includes(unit));
  const api = async (route: string, body?: unknown): Promise<any> => {
    const response = await fetch(`http://localhost:${port}/api/${route}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(2000) });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  };
  await until(async () => { try { return (await api("health")).executionProtocol === 1; } catch { return false; } }, "web health");
  const repo = (await api("repos", { path: join(root, "repo"), defaultBaseRef: "main" })).repo;
  const running: Array<{ taskId: string; key: string; pid: number; session: string }> = [];
  for (const agent of ["claude", "codex"]) {
    const { task } = await api("tasks", { repoId: repo.id, agent, isolate: true, prompt: JSON.stringify({ key: agent, mode: agent === "claude" ? "answered-hold" : "hold" }) });
    const ready = join(root, "control", agent + ".ready");
    await until(() => existsSync(ready), `${agent} provider starts`);
    running.push({ taskId: task.taskId, key: agent, ...JSON.parse(readFileSync(ready, "utf8")) });
  }
  executions = new ExecutionStore(join(dataDir, "executions"));
  const identities = executions.list();
  for (const record of identities) {
    assert(readFileSync(`/proc/${record.pid}/cgroup`, "utf8").includes(`${unit}/executions/${record.id}`));
    const host = await daemonRequest(dataDir, { action: "inspect", kind: "execution", id: record.id }) as { lifecycle: { phase: string } };
    assert.equal(host.lifecycle.phase, "ready");
  }

  terminals = new TerminalStore(join(dataDir, "terminals"));
  const { record: terminal } = terminals.reserve({ requestId: randomUUID(), repoId: repo.id, title: "Acceptance", initialCwd: join(root, "repo"),
    directory: terminals.directory, release, node, cols: 80, rows: 24 });
  writeFileSync(join(terminals.directory, terminal.id + ".json"), JSON.stringify({ protocol: 1, id: terminal.id, directory: terminals.directory, release, node }), { mode: 0o600 });
  await daemonRequest(dataDir, { action: "launch", kind: "terminal", id: terminal.id });
  await until(() => terminals!.get(terminal.id)?.state === "running", "terminal starts");
  const frames: TerminalFrame[] = [];
  const attach = async () => {
    terminalChannel = await unixTransport.connect(terminals!.directory, terminal.id);
    terminalChannel.onMessage(value => { const frame = value as TerminalFrame; frames.push(frame); if ("seq" in frame) terminalChannel!.send({ type: "ack", seq: frame.seq }); });
    await until(() => frames.some(frame => frame.type === "snapshot"), "terminal snapshot");
  };
  await attach();
  terminalChannel!.send({ type: "claim-control" });
  await until(() => frames.some(frame => frame.type === "control" && frame.writable), "terminal writer");
  const control = frames.findLast(frame => frame.type === "control");
  assert(control?.type === "control");
  const escapedPid = join(root, "control/escaped.pid");
  terminalChannel!.send({ type: "input", epoch: control.epoch,
    data: `printf 'DAEMON-%s\\n' 'TERMINAL'; setsid sh -c 'echo $$ > "${escapedPid}"; exec sleep 600' &\r` });
  await until(() => existsSync(escapedPid) && frames.some(frame => frame.type === "output" && frame.data.includes("DAEMON-TERMINAL")), "terminal input and detached descendant");
  terminalChannel!.close(); frames.length = 0;
  const terminalPid = terminals.get(terminal.id)!.pid;

  const { routine } = await api("routines", { repoId: repo.id, kind: "script", preset: "manual", script: {
    command: `echo $$ > "$PROBE_CONTROL/routine.pid"; echo once >> "$PROBE_CONTROL/routine-invocations"; setsid sh -c 'echo $$ > "$PROBE_CONTROL/routine-escaped.pid"; exec sleep 600' & while [ ! -f "$PROBE_CONTROL/routine.release" ]; do sleep 0.1; done; printf routine-complete`, timeoutSeconds: 120,
  } });
  await api(`routines/${routine.id}/run`, {});
  await until(() => existsSync(join(root, "control/routine.pid")) && existsSync(join(root, "control/routine-escaped.pid")), "routine starts with detached descendant");
  const routinePid = Number(readFileSync(join(root, "control/routine.pid"), "utf8").trim());
  const routineEscapedPid = Number(readFileSync(join(root, "control/routine-escaped.pid"), "utf8").trim());
  const routineRun = (await api(`routines/${routine.id}/runs`)).runs[0];
  const routineHostId = routineRun.id.toString(16);
  assert(readFileSync(`/proc/${routinePid}/cgroup`, "utf8").includes(`${unit}/routines/${routineHostId}`));
  const routineState = await daemonRequest(dataDir, { action: "inspect", kind: "routine", id: routineHostId }) as { lifecycle: { phase: string } };
  assert.equal(routineState.lifecycle.phase, "ready");
  assert.equal((await api("health")).activeRoutineScripts, 1);
  assert.equal((await api("health")).updateBlockingRoutineScripts, 0);

  const before = DaemonStatusSchema.parse(await daemonRequest(dataDir, { action: "status" }));
  await daemonRequest(dataDir, { action: "replace" });
  await until(async () => { try { return DaemonStatusSchema.parse(await daemonRequest(dataDir, { action: "status" })).instance !== before.instance; } catch { return false; } }, "daemon replacement");
  process.kill(before.pid, "SIGKILL");
  await until(async () => { try { return DaemonStatusSchema.parse(await daemonRequest(dataDir, { action: "status" })).pid !== before.pid; } catch { return false; } }, "bootstrap recovers daemon crash");

  const oldWeb = (await daemonRequest(dataDir, { action: "status" }) as { web: { guard: { pid: number }; child: { pid: number } } }).web;
  process.kill(oldWeb.guard.pid, "SIGKILL");
  await until(async () => {
    const web = DaemonStatusSchema.parse(await daemonRequest(dataDir, { action: "status" })).web;
    return web?.lifecycle?.phase === "ready" && (web.child as { pid: number } | undefined)?.pid !== oldWeb.child.pid;
  }, "web guardian loss recovers a ready replacement");

  const replacement = join(dataDir, "releases/second");
  cpSync(prefix, replacement, { recursive: true });
  config.release = join(replacement, "node_modules/palmagent"); config.daemon = daemonBinary(config.release);
  config.environment.EXECUTION_RELEASE = config.release; config.environment.STATIC_DIR = join(config.release, "web"); save();
  await daemonRequest(dataDir, { action: "restart-web" });
  await until(async () => { try { return (await api("health")).executionProtocol === 1; } catch { return false; } }, "replacement web");
  process.kill(routinePid, 0);
  const retainedRoutine = await daemonRequest(dataDir, { action: "inspect", kind: "routine", id: routineHostId }) as { release: string; alive: boolean };
  assert.equal(retainedRoutine.release, release); assert(retainedRoutine.alive);
  assert.equal((await api(`routines/${routine.id}/runs`)).runs[0].status, "running");
  writeFileSync(join(root, "control/routine.release"), "");
  await until(async () => (await api(`routines/${routine.id}/runs`)).runs[0].status === "succeeded", "routine result recovered after web activation");
  assert.equal((await api(`routines/${routine.id}/runs`)).runs[0].output, "routine-complete");
  assert.equal(readFileSync(join(root, "control/routine-invocations"), "utf8"), "once\n");
  await until(() => !existsSync(`/proc/${routineEscapedPid}`), "routine detached descendant cleanup");
  await attach();
  assert(frames.some(frame => frame.type === "snapshot" && frame.data.includes("DAEMON-TERMINAL")));
  assert.equal(terminals.get(terminal.id)!.pid, terminalPid);
  terminalChannel!.close();
  const terminalHost = await daemonRequest(dataDir, { action: "inspect", kind: "terminal", id: terminal.id }) as { guard: { pid: number }; lifecycle: { readiness: string } };
  assert.equal(terminalHost.lifecycle.readiness, "ready");
  process.kill(terminalHost.guard.pid, "SIGKILL");
  await until(async () => {
    const host = await daemonRequest(dataDir, { action: "inspect", kind: "terminal", id: terminal.id }) as { alive: boolean; lifecycle: { reason: string } };
    return !host.alive && host.lifecycle.reason === "guardian_lost";
  }, "orphaned terminal is reconciled without replay");
  const escaped = Number(readFileSync(escapedPid, "utf8").trim());
  await until(() => !existsSync(`/proc/${escaped}`), "detached descendant cleanup");

  for (const run of running) {
    process.kill(run.pid, 0);
    const task = (await api(`tasks/${run.taskId}`)).task;
    assert.equal(task.sessionId, run.session);
    if (run.key === "claude") {
      assert.equal(task.pendingInput.requestId, "q1");
      await api(`tasks/${run.taskId}/answer`, { requestId: "q1", answers: [{ question: "Continue?", selected: ["Yes"] }] });
      await until(() => existsSync(join(root, "control/claude.answer")), "original provider stdin");
    }
    writeFileSync(join(root, "control", run.key + ".release"), "");
    await until(async () => (await api(`tasks/${run.taskId}`)).task.status === "idle", `${run.key} completes`);
  }
  assert.deepEqual(executions.list().map(row => [row.id, row.pid, row.release]), identities.map(row => [row.id, row.pid, row.release]));
  // No pending update: the independent CLI still reports readiness and exits without mutation.
  const updater = await daemonRequest(dataDir, { action: "start-update" }) as { lifecycle: { readyAt: number | null } };
  assert.equal(typeof updater.lifecycle.readyAt, "number");
  const inventory = await daemonRequest(dataDir, { action: "list" }) as { hosts: unknown[] };
  assert(inventory.hosts.length > 0 && inventory.hosts.length <= 32);
  assert(!existsSync(join(root, "forbidden-service-call")), "Runtime must not invoke sudo or systemctl");
  await until(async () => { try { await daemonRequest(dataDir, { action: "stop" }); return true; } catch { return false; } }, "idle runtime stops");
  if (installed) { await removeDaemonBootstrap(installed); installed = undefined; }
  assert(!existsSync(join(root, "forbidden-service-call")), "User installation and removal must not invoke sudo");
  console.log("PASS: Rust daemon replacement/crash and web activation preserve provider PIDs, input, journals, terminal state, routine results, readiness and orphan cgroup cleanup without privileged runtime calls");
} finally {
  terminalChannel?.close(); executions?.close(); terminals?.close();
  // The only privileged cleanup target is this run's uniquely named cgroup/unit.
  if (systemScope) spawnSync("/usr/bin/sudo", ["-n", "systemctl", "stop", unit], { stdio: "pipe" });
  else spawnSync("/usr/bin/systemctl", ["--user", "stop", unit], { stdio: "pipe", env: userServiceEnvironment() });
  if (cgroup?.includes(unit)) {
    const group = join("/sys/fs/cgroup", cgroup);
    if (!systemScope && existsSync(join(group, "cgroup.kill"))) writeFileSync(join(group, "cgroup.kill"), "1");
    if (systemScope && existsSync(join(group, "cgroup.kill"))) spawnSync("/usr/bin/sudo", ["-n", "sh", "-c", 'printf 1 > "$1/cgroup.kill"', "cleanup", group], { stdio: "pipe" });
    await until(() => !existsSync(join(group, "cgroup.events")) || readFileSync(join(group, "cgroup.events"), "utf8").includes("populated 0"), "fixture cleanup").catch(() => {});
    cleanupConfirmed = !existsSync(join(group, "cgroup.events")) || readFileSync(join(group, "cgroup.events"), "utf8").includes("populated 0");
  } else cleanupConfirmed = !cgroup;
  if (systemScope) spawnSync("/usr/bin/sudo", ["-n", "systemctl", "reset-failed", unit], { stdio: "pipe" });
  else {
    if (installed) await removeDaemonBootstrap(installed);
    spawnSync("/usr/bin/systemctl", ["--user", "reset-failed", unit], { stdio: "pipe", env: userServiceEnvironment() });
  }
  process.env = originalEnvironment;
  if (cleanupConfirmed) rmSync(root, { recursive: true, force: true });
  else console.error("Acceptance fixture retained because process cleanup could not be confirmed");
}
