import { startDaemonControlFixture } from "../support/daemon-control.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, lstatSync, realpathSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DaemonConfigurationSchema } from "@palmagent/shared/daemon";
import { assertDaemonBootstrapSupported, installDaemonBootstrap, removeDaemonBootstrap } from "../../src/modules/installation/adapters/outbound/daemon-bootstrap.js";
import { activateDaemon, configureDaemon, daemonBinary, daemonStatus } from "../../src/modules/installation/adapters/outbound/daemon-runtime.js";
import { configureAutoUpdate, prepareUpdateService, startRequestedUpdate } from "../../src/modules/installation/adapters/outbound/auto-update.js";
import { DEFAULT_CAPS, saveConfig, loadConfig, type InstallConfig } from "../../src/modules/installation/adapters/outbound/config.js";
import { daemonServiceName, prepareUserService, verifyUserIsolation } from "../../src/modules/installation/adapters/outbound/user-service.js";
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
if (process.argv.includes('bootstrap-unit')) { console.log('[Service]\\nExecStart=/example/launcher\\n[Install]\\nWantedBy=default.target'); process.exit(0); }
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

test("release selection adopts a frozen launcher as an alias and restores both paths on rollback", t => {
  const f = fixture(t);
  const oldBytes = readFileSync(f.binary);
  configureDaemon(f.cfg);
  assert(lstatSync(join(f.root, "daemon/current")).isSymbolicLink());
  assert(lstatSync(join(f.root, "daemon/launcher")).isSymbolicLink());
  const release = join(f.root, "releases/r2");
  cpSync(f.release, release, { recursive: true });
  configureDaemon({ ...f.cfg, pkgDir: release });
  assert.equal(realpathSync(join(f.root, "daemon/current")), daemonBinary(release));
  assert.equal(realpathSync(join(f.root, "daemon/launcher")), daemonBinary(release));
  configureDaemon(f.cfg);
  assert.equal(realpathSync(join(f.root, "daemon/current")), f.binary);
  assert.equal(realpathSync(join(f.root, "daemon/launcher")), f.binary);
  assert.deepEqual(readFileSync(f.binary), oldBytes, "retained executable contents never change");
});

test("a fresh runtime has a current executable link and no compatibility launcher", t => {
  const f = fixture(t);
  rmSync(join(f.root, "daemon/launcher"));
  configureDaemon(f.cfg);
  assert.equal(realpathSync(join(f.root, "daemon/current")), f.binary);
  assert(!existsSync(join(f.root, "daemon/launcher")));
});

test("daemon settings, independent update requests and activation never invoke privileged service commands", async t => {
  const f = fixture(t);
  configureDaemon(f.cfg);
  await startDaemonControlFixture(t, f.root);
  await prepareUpdateService(f.cfg);
  await configureAutoUpdate(f.cfg, true);
  assert.equal(getUserConfig({ dataDir: f.root }).autoUpdate, true);
  await startRequestedUpdate(f.cfg);
  await activateDaemon(f.cfg);
  assert.match((await daemonStatus(f.cfg)).instance, /^replacement-/);
  const actions = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line).action);
  assert(actions.includes("start-update"));
  assert(actions.indexOf("replace") < actions.indexOf("restart-web"));
  await configureAutoUpdate(f.cfg, false);
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

test("failed initial bootstrap can be removed only when its empty state is verified", async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "daemon/launcher"), `#!${process.execPath}\nprocess.exit(1);\n`);
  writeFileSync(join(f.root, "bin/systemctl"), `#!${process.execPath}\nconsole.log('/unrelated-group');\n`, { mode: 0o700 });
  await assert.rejects(() => removeDaemonBootstrap(f.cfg));
  assert(!existsSync(f.privileged));
  writeFileSync(join(f.root, "bin/systemctl"), `#!${process.execPath}\nconsole.log('');\n`, { mode: 0o700 });
  writeFileSync(join(f.root, "bin/sudo"), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(f.privileged)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o700 });
  await removeDaemonBootstrap(f.cfg);
  const calls = readFileSync(f.privileged, "utf8");
  assert.match(calls, /disable/);
  assert.match(calls, /daemon-reload/);
});

function userFixture(t: TestContext) {
  const f = fixture(t);
  f.cfg.daemonScope = "user";
  f.cfg.daemonUnitDir = join(f.root, "units");
  const serviceCalls = join(f.root, "service-calls.jsonl");
  const linger = join(f.root, "linger");
  writeFileSync(linger, "yes");
  for (const name of ["loginctl", "systemctl", "systemd-run"]) {
    writeFileSync(join(f.root, "bin", name), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), name = ${JSON.stringify(name)};
fs.appendFileSync(${JSON.stringify(serviceCalls)}, JSON.stringify({ name, args, bus: process.env.DBUS_SESSION_BUS_ADDRESS }) + '\\n');
if (name === 'loginctl') {
  if (args.includes('enable-linger')) {
    if (fs.existsSync(${JSON.stringify(join(f.root, "deny-linger"))})) process.exit(1);
    fs.writeFileSync(${JSON.stringify(linger)}, 'yes');
  } else console.log(fs.readFileSync(${JSON.stringify(linger)}, 'utf8'));
} else if (name === 'systemd-run') {
  if (fs.existsSync(${JSON.stringify(join(f.root, "deny-isolation"))})) process.exit(1);
  console.log('delegated-isolation-ready');
} else if (args.includes('--version')) console.log('systemd 255');
else if (args.includes('--property=Version')) console.log('255');
else if (args.includes('--property=UnitPath')) console.log(${JSON.stringify(f.cfg.daemonUnitDir)});
else if (args.includes('--property=FragmentPath')) console.log(${JSON.stringify(join(f.cfg.daemonUnitDir, daemonServiceName(f.cfg)))});
`, { mode: 0o700 });
  }
  return { ...f, serviceCalls, linger };
}

test("user prerequisites enable lingering once without sudo and ignore a login session's private bus", t => {
  const f = userFixture(t);
  process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/private/session/bus";
  writeFileSync(f.linger, "no");
  prepareUserService(f.cfg, true);
  assert.equal(readFileSync(f.linger, "utf8"), "no", "dry-run must not enable linger");
  prepareUserService(f.cfg);
  prepareUserService(f.cfg);
  const calls = readFileSync(f.serviceCalls, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.filter(call => call.args.includes("enable-linger")).length, 1);
  assert(calls.filter(call => call.name === "systemctl").every(call => call.args.includes("--user") && call.bus === `unix:path=/run/user/${process.getuid!()}/bus`));
  assert(!existsSync(f.privileged));
});

test("denied linger and delegated isolation fail before changing an existing daemon configuration", t => {
  const f = userFixture(t);
  configureDaemon(f.cfg);
  const prior = readFileSync(join(f.root, "daemon/config.json"), "utf8");
  writeFileSync(f.linger, "no");
  writeFileSync(join(f.root, "deny-linger"), "");
  assert.throws(() => prepareUserService(f.cfg), /administrator authentication/);
  writeFileSync(join(f.root, "deny-isolation"), "");
  assert.throws(() => verifyUserIsolation(f.cfg), /isolation is unavailable/);
  assert.equal(readFileSync(join(f.root, "daemon/config.json"), "utf8"), prior);
  assert(!existsSync(f.privileged));
});

test("user scope and unit directory survive environment changes; absent scope stays legacy", t => {
  const f = userFixture(t);
  saveConfig(f.cfg);
  process.env.XDG_CONFIG_HOME = join(f.root, "different-config");
  const loaded = loadConfig({ dataDir: f.root });
  assert.equal(loaded.daemonScope, "user");
  assert.equal(loaded.daemonUnitDir, f.cfg.daemonUnitDir);
  assert.equal(daemonServiceName(loaded), daemonServiceName(f.cfg));
  assert.notEqual(daemonServiceName({ ...f.cfg, dataDir: join(f.root, "second") }), daemonServiceName(f.cfg));
  saveConfig({ ...f.cfg, daemonScope: undefined, daemonUnitDir: undefined });
  assert.equal(loadConfig({ dataDir: f.root }).daemonScope, undefined);
  assert.equal(daemonServiceName(loadConfig({ dataDir: f.root })), "palmagentd.service");
});

test("user bootstrap registration and removal never invoke sudo or disable account lingering", async t => {
  const f = userFixture(t);
  configureDaemon(f.cfg);
  await startDaemonControlFixture(t, f.root);
  // Bootstrap rendering is independent of the socket control peer.
  writeFileSync(f.binary, `#!${process.execPath}\nconsole.log('[Service]\\nExecStart=/example/launcher\\n[Install]\\nWantedBy=default.target');\n`, { mode: 0o700 });
  writeFileSync(join(f.release, "daemon/manifest.json"), JSON.stringify({ protocol: 1, artifacts: {
    [`${process.platform}-${process.arch}`]: createHash("sha256").update(readFileSync(f.binary)).digest("hex"),
  } }));
  installDaemonBootstrap(f.cfg);
  installDaemonBootstrap(f.cfg);
  const path = join(f.cfg.daemonUnitDir!, daemonServiceName(f.cfg));
  assert(existsSync(path));
  await removeDaemonBootstrap(f.cfg);
  assert(!existsSync(path));
  assert(!existsSync(f.privileged));
  assert(!readFileSync(f.serviceCalls, "utf8").includes("disable-linger"));
});

for (const outcome of ["busy", "start-failed", "health-failed", "healthy", "fresh"] as const) {
  test(`system-to-user migration ${outcome} preserves the idle and recovery contract`, async t => {
    const f = userFixture(t);
    process.env.XDG_CONFIG_HOME = join(f.root, "config");
    f.cfg.daemonUnitDir = join(process.env.XDG_CONFIG_HOME, "systemd/user");
    // Keep mock user-manager paths aligned with the installer-selected directory.
    const systemctl = join(f.root, "bin/systemctl");
    writeFileSync(systemctl, readFileSync(systemctl, "utf8").replaceAll(join(f.root, "units"), f.cfg.daemonUnitDir) +
      (outcome === "start-failed" ? "\nif (args.includes('start') && args.includes('--user')) process.exit(1);\n" : ""));
    const previous = { ...f.cfg, daemonScope: undefined, daemonUnitDir: undefined };
    configureDaemon(previous); saveConfig(previous);
    const priorConfig = readFileSync(join(f.root, "daemon/config.json"), "utf8");
    if (outcome === "fresh") {
      rmSync(join(f.root, "install.env"));
      writeFileSync(join(f.release, "runtime-contract.json"), JSON.stringify({ executionProtocol: 1, productStorage: 1, applicationApi: 1, daemonProtocol: 1 }));
      for (const name of ["cli.js", "execution-host.js", "execution-launcher.js"]) writeFileSync(join(f.release, name), "// Fixture");
    }
    writeFileSync(join(f.release, "server.js"), "// Package fixture");
    writeFileSync(join(f.release, "package.json"), JSON.stringify({ version: "0.1.0-alpha.1" }));
    writeFileSync(join(f.root, "bin/sudo"), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(f.privileged)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o700 });
    writeFileSync(join(f.root, "bin/curl"), `#!${process.execPath}\nconsole.log(JSON.stringify({ok:true}));\n`, { mode: 0o700 });
    const entry = join(f.release, "test-installer.mjs");
    await build({ stdin: { contents: `
      import { createInstaller } from ${JSON.stringify(fileURLToPath(new URL("../../src/composition/installation.ts", import.meta.url)))};
      globalThis.fetch = async () => Response.json({ok:true, updateMaintenance:true, executionProtocol:1, activeRoutineScripts:0, updateBlockingRoutineScripts:0});
      const installer = createInstaller({ stageRelease() {}, verifyActiveExecutionCompatibility() {},
        assertExecutionsFinished() { ${outcome === "busy" ? "throw new Error('active terminal');" : ""} }, doctor() { return []; } });
      try { process.exitCode = await installer.${outcome === "fresh" ? "install" : "setup"}({dryRun:false, nonInteractive:true, force:true, purge:false, pull:false,
        get(key) { return key === 'data-dir' ? ${JSON.stringify(f.root)} : key === 'domain' ? 'palmagent.example.com' : key === 'channel' ? 'preview' : undefined; } }); }
      catch(error) { console.error(error.message); process.exitCode = 1; }
    `, resolveDir: process.cwd(), sourcefile: "migration-fixture.ts", loader: "ts" }, bundle: true, platform: "node", format: "esm", banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, outfile: entry, logLevel: "silent" });
    if (outcome === "health-failed") {
      const unhealthy = join(f.root, "unhealthy");
      writeFileSync(systemctl, readFileSync(systemctl, "utf8") + `\nif (args.includes('start') && args.includes('--user')) fs.writeFileSync(${JSON.stringify(unhealthy)}, '1');\n`);
      const privileged = join(f.root, "bin/sudo");
      writeFileSync(privileged, readFileSync(privileged, "utf8") + `\nif (process.argv.includes('start')) require('node:fs').rmSync(${JSON.stringify(unhealthy)}, {force:true});\n`);
      writeFileSync(join(f.root, "bin/curl"), `#!${process.execPath}\nif (require('node:fs').existsSync(${JSON.stringify(unhealthy)})) process.exit(1); console.log(JSON.stringify({ok:true}));\n`, { mode: 0o700 });
      writeFileSync(join(f.root, "bin/sleep"), `#!${process.execPath}\n`, { mode: 0o700 });
    }
    await startDaemonControlFixture(t, f.root);
    const result = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, ["healthy", "fresh"].includes(outcome) ? 0 : 1, result.stdout + result.stderr);
    const current = loadConfig({ dataDir: f.root });
    assert.equal(current.daemonScope, ["healthy", "fresh"].includes(outcome) ? "user" : undefined);
    if (outcome === "busy") {
      assert.match(result.stderr, /active terminal/);
      assert(!existsSync(f.privileged));
      assert(readFileSync(f.serviceCalls, "utf8").trim().split("\n").every(line => JSON.parse(line).args.includes("--version")));
    } else if (outcome === "fresh") {
      assert(!existsSync(f.privileged), "fresh installation must never invoke sudo");
    } else {
      const calls = readFileSync(f.privileged, "utf8");
      assert.match(calls, /disable.*--now.*palmagentd.service/);
      if (["start-failed", "health-failed"].includes(outcome)) {
        assert.match(calls, /enable.*palmagentd.service/);
        assert.match(calls, /start.*palmagentd.service/);
      } else assert.match(calls, /rm.*palmagentd.service/);
    }
    if (!["healthy", "fresh"].includes(outcome)) assert.equal(readFileSync(join(f.root, "daemon/config.json"), "utf8"), priorConfig);
    assert(!existsSync(join(f.root, "daemon-migration.json")));
  });
}

test("removal refuses an unmanaged user service before stopping the daemon", async t => {
  const f = userFixture(t);
  configureDaemon(f.cfg);
  mkdirSync(f.cfg.daemonUnitDir!);
  writeFileSync(join(f.cfg.daemonUnitDir!, daemonServiceName(f.cfg)), "# Independently managed service\n");
  await assert.rejects(() => removeDaemonBootstrap(f.cfg), /unmanaged user service/);
  assert(!existsSync(f.calls));
  assert(!existsSync(f.privileged));
});


test("application artifacts are verified before selecting a native configuration", t => {
  const f = fixture(t);
  const name = `${process.platform}-${process.arch}`;
  const manifestPath = join(f.release, "daemon/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const application = join(f.release, `daemon/${name}/palmagent-runtime`);
  writeFileSync(application, "fixture application");
  manifest.applicationRuntime = 1;
  manifest.applicationArtifacts = { [name]: createHash("sha256").update(readFileSync(application)).digest("hex") };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(daemonBinary(f.release), f.binary);
  writeFileSync(application, "corrupt application");
  assert.throws(() => daemonBinary(f.release), /Application runtime artifact integrity mismatch/);
  manifest.applicationRuntime = 2;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => daemonBinary(f.release), /application runtime/i);
});
