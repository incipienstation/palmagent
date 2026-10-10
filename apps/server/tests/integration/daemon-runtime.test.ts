import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DaemonConfigurationSchema } from "@palmagent/shared/daemon";
import { assertDaemonBootstrapSupported, removeDaemonBootstrap } from "../../src/modules/installation/adapters/outbound/daemon-bootstrap.js";
import { activateDaemon, configureDaemon, daemonBinary, daemonStatus } from "../../src/modules/installation/adapters/outbound/daemon-runtime.js";
import { configureAutoUpdate, prepareUpdateService, startRequestedUpdate } from "../../src/modules/installation/adapters/outbound/auto-update.js";
import { DEFAULT_CAPS, saveConfig, loadConfig, type InstallConfig } from "../../src/modules/installation/adapters/outbound/config.js";
import { getUserConfig } from "../../src/modules/installation/adapters/outbound/user-config.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "palmagent-daemon-contract-"));
  const environment = { ...process.env };
  t.after(() => { process.env = environment; rmSync(root, { recursive: true, force: true }); });
  process.env.PALMAGENT_HOME = join(root, "preferences");
  process.env.PATH = join(root, "bin") + ":" + process.env.PATH;
  const release = join(root, "releases/r1"), node = join(root, "runtimes/node");
  for (const directory of [release, join(root, "runtimes"), join(release, `daemon/${process.platform}-${process.arch}`), join(root, "daemon"), join(root, "bin")]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  copyFileSync(process.execPath, node);
  writeFileSync(join(release, "build-info.json"), JSON.stringify({ version: "0.1.0-alpha.1", sourceCommit: "a".repeat(40) }));
  const calls = join(root, "requests.jsonl"), privileged = join(root, "privileged");
  for (const name of ["sudo", "systemctl"]) writeFileSync(join(root, "bin", name), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(privileged)}, 'called'); process.exit(1);\n`, { mode: 0o700 });
  const binary = join(release, `daemon/${process.platform}-${process.arch}/palmagentd`);
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(request) + '\\n');
const generation = ${JSON.stringify(join(root, "generation"))};
let instance = fs.existsSync(generation) ? fs.readFileSync(generation, 'utf8') : 'first';
if (request.action === 'replace') { instance = 'replacement'; fs.writeFileSync(generation, instance); }
const config = JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "daemon/config.json"))}, 'utf8'));
const build = JSON.parse(fs.readFileSync(path.join(config.release, 'build-info.json'), 'utf8'));
console.log(JSON.stringify(request.action === 'status' ? { protocol: 1, ...build, instance, pid: process.pid, isolation: 'cgroup', web: { state: 'running', alive: true } } : {}));
`, { mode: 0o700 });
  writeFileSync(join(release, "daemon/manifest.json"), JSON.stringify({ protocol: 1, artifacts: {
    [`${process.platform}-${process.arch}`]: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  } }));
  copyFileSync(binary, join(root, "daemon/launcher"));
  const cfg: InstallConfig = {
    mode: "package", supervisor: "palmagentd", user: userInfo().username, group: userInfo().username,
    dataDir: root, pkgDir: release, workingDir: release, executionNode: node, runnerSocket: join(root, "runner.sock"), dbPath: join(root, "palmagent.db"),
    execPath: process.env.PATH!, domain: "palmagent.example.com", host: "localhost", port: 4100, concurrency: 2,
    rpId: "palmagent.example.com", rpName: "Palmagent", authOrigin: "https://palmagent.example.com", caps: DEFAULT_CAPS,
    pushSubject: "", repoRoots: "", claudeConfigDir: "",
  };
  return { root, release, binary, cfg, calls, privileged };
}

test("daemon configuration pins native and Node artifacts and preserves the supervisor selection", t => {
  const f = fixture(t);
  configureDaemon(f.cfg); saveConfig(f.cfg);
  const config = DaemonConfigurationSchema.parse(JSON.parse(readFileSync(join(f.root, "daemon/config.json"), "utf8")));
  assert.equal(config.daemon, f.binary);
  assert.equal(config.node, f.cfg.executionNode);
  assert.equal(config.environment.EXECUTION_RELEASE, f.release);
  assert.equal(config.limits.memoryMax, 16 * 1024 ** 3);
  assert.equal(loadConfig({ dataDir: f.root }).supervisor, "palmagentd");
  assert(!existsSync(f.privileged));
});

test("daemon settings, independent update requests and activation never invoke privileged service commands", t => {
  const f = fixture(t);
  configureDaemon(f.cfg);
  prepareUpdateService(f.cfg);
  configureAutoUpdate(f.cfg, true);
  assert.equal(getUserConfig({ dataDir: f.root }).autoUpdate, true);
  startRequestedUpdate(f.cfg);
  activateDaemon(f.cfg);
  assert.equal(daemonStatus(f.cfg).instance, "replacement");
  const actions = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line).action);
  assert(actions.includes("start-update"));
  assert(actions.indexOf("replace") < actions.indexOf("restart-web"));
  configureAutoUpdate(f.cfg, false);
  assert.equal(getUserConfig({ dataDir: f.root }).autoUpdate, false);
  assert(!existsSync(f.privileged));
});

test("corrupt or unsupported native artifacts are rejected before changing active configuration", t => {
  const f = fixture(t);
  configureDaemon(f.cfg);
  const prior = readFileSync(join(f.root, "daemon/config.json"), "utf8");
  writeFileSync(f.binary, "corrupt native artifact");
  assert.throws(() => configureDaemon(f.cfg), /integrity mismatch/);
  assert.throws(() => daemonBinary(f.release, "win32"), /no compatible daemon/);
  assert.equal(readFileSync(join(f.root, "daemon/config.json"), "utf8"), prior);
  assert(!existsSync(f.privileged));
});


test("bootstrap migration rejects old systemd before privileged mutations", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "bin/systemctl"), `#!${process.execPath}\nconsole.log('systemd 253');\n`, { mode: 0o700 });
  assert.throws(() => assertDaemonBootstrapSupported(), /254 or newer/);
  assert(!existsSync(f.privileged));
});

test("failed initial bootstrap can be removed only when its empty state is verified", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "daemon/launcher"), `#!${process.execPath}\nprocess.exit(1);\n`);
  writeFileSync(join(f.root, "bin/systemctl"), `#!${process.execPath}\nconsole.log('/unrelated-group');\n`, { mode: 0o700 });
  assert.throws(() => removeDaemonBootstrap(f.cfg));
  assert(!existsSync(f.privileged));
  writeFileSync(join(f.root, "bin/systemctl"), `#!${process.execPath}\nconsole.log('');\n`, { mode: 0o700 });
  writeFileSync(join(f.root, "bin/sudo"), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(f.privileged)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o700 });
  removeDaemonBootstrap(f.cfg);
  const calls = readFileSync(f.privileged, "utf8");
  assert.match(calls, /disable/);
  assert.match(calls, /daemon-reload/);
});
