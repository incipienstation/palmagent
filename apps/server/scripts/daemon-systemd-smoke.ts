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
import { daemonBinary } from "../src/modules/installation/adapters/outbound/daemon-runtime.js";
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
execFileSync("sudo", ["-n", "true"], { stdio: "pipe" });
const root = mkdtempSync(join(tmpdir(), "palmagentd-acceptance-"));
const dataDir = join(root, "data");
const unit = `palmagentd-test-${randomUUID().replaceAll("-", "")}.service`;
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
try {
  for (const directory of ["home", "control", "bin", "repo", "data/daemon", "data/releases/first"]) mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", root], { cwd: artifact, encoding: "utf8" }));
  const prefix = join(dataDir, "releases/first");
  execFileSync("npm", ["install", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund", join(root, packed[0].filename)], { stdio: "pipe" });
  const release = join(prefix, "node_modules/palmagent");
  const node = pinNode(dataDir);
  const binary = daemonBinary(release);
  copyFileSync(binary, join(dataDir, "daemon/launcher"));
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
  const save = () => writeFileSync(join(dataDir, "daemon/config.json"), JSON.stringify(config), { mode: 0o600 });
  save();
  admin("systemd-run", "--quiet", "--collect", `--unit=${unit}`, `--uid=${userInfo().username}`,
    "--property=Delegate=cpu memory pids", "--property=DelegateSubgroup=control", "--property=KillMode=process", "--property=Restart=on-failure", "--property=RestartSec=1",
    "--property=LimitNOFILE=65536", "--property=TasksMax=infinity", binary, "serve", "--data-dir", dataDir);
  cgroup = admin("systemctl", "show", unit, "--property=ControlGroup", "--value").trim();
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
  for (const record of identities) assert(readFileSync(`/proc/${record.pid}/cgroup`, "utf8").includes(`${unit}/executions/${record.id}`));

  terminals = new TerminalStore(join(dataDir, "terminals"));
  const { record: terminal } = terminals.reserve({ requestId: randomUUID(), repoId: repo.id, title: "Acceptance", initialCwd: join(root, "repo"),
    directory: terminals.directory, release, node, cols: 80, rows: 24 });
  writeFileSync(join(terminals.directory, terminal.id + ".json"), JSON.stringify({ protocol: 1, id: terminal.id, directory: terminals.directory, release, node }), { mode: 0o600 });
  daemonRequest(dataDir, { action: "launch", kind: "terminal", id: terminal.id });
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

  const before = DaemonStatusSchema.parse(daemonRequest(dataDir, { action: "status" }));
  daemonRequest(dataDir, { action: "replace" });
  await until(() => { try { return DaemonStatusSchema.parse(daemonRequest(dataDir, { action: "status" })).instance !== before.instance; } catch { return false; } }, "daemon replacement");
  process.kill(before.pid, "SIGKILL");
  await until(() => { try { return DaemonStatusSchema.parse(daemonRequest(dataDir, { action: "status" })).pid !== before.pid; } catch { return false; } }, "bootstrap recovers daemon crash");

  const replacement = join(dataDir, "releases/second");
  cpSync(prefix, replacement, { recursive: true });
  config.release = join(replacement, "node_modules/palmagent"); config.daemon = daemonBinary(config.release);
  config.environment.EXECUTION_RELEASE = config.release; config.environment.STATIC_DIR = join(config.release, "web"); save();
  daemonRequest(dataDir, { action: "restart-web" });
  await until(async () => { try { return (await api("health")).executionProtocol === 1; } catch { return false; } }, "replacement web");
  await attach();
  assert(frames.some(frame => frame.type === "snapshot" && frame.data.includes("DAEMON-TERMINAL")));
  assert.equal(terminals.get(terminal.id)!.pid, terminalPid);
  terminalChannel!.close();
  daemonRequest(dataDir, { action: "terminate", kind: "terminal", id: terminal.id });
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
  assert(!existsSync(join(root, "forbidden-service-call")), "Runtime must not invoke sudo or systemctl");
  await until(() => { try { daemonRequest(dataDir, { action: "stop" }); return true; } catch { return false; } }, "idle runtime stops");
  console.log("PASS: Rust daemon replacement/crash and web activation preserve provider PIDs, input, journals, terminal state and cgroup cleanup without privileged runtime calls");
} finally {
  terminalChannel?.close(); executions?.close(); terminals?.close();
  // The only privileged cleanup target is this run's uniquely named cgroup/unit.
  spawnSync("/usr/bin/sudo", ["-n", "systemctl", "stop", unit], { stdio: "pipe" });
  if (cgroup?.includes(unit)) {
    const group = join("/sys/fs/cgroup", cgroup);
    if (existsSync(join(group, "cgroup.kill"))) spawnSync("/usr/bin/sudo", ["-n", "sh", "-c", 'printf 1 > "$1/cgroup.kill"', "cleanup", group], { stdio: "pipe" });
    await until(() => !existsSync(join(group, "cgroup.events")) || readFileSync(join(group, "cgroup.events"), "utf8").includes("populated 0"), "fixture cleanup").catch(() => {});
    cleanupConfirmed = !existsSync(join(group, "cgroup.events")) || readFileSync(join(group, "cgroup.events"), "utf8").includes("populated 0");
  } else cleanupConfirmed = !cgroup;
  spawnSync("/usr/bin/sudo", ["-n", "systemctl", "reset-failed", unit], { stdio: "pipe" });
  if (cleanupConfirmed) rmSync(root, { recursive: true, force: true });
  else console.error("Acceptance fixture retained because process cleanup could not be confirmed");
}
