import assert from "node:assert/strict";
import { test } from "node:test";
import { createInstallationService } from "../../../src/modules/installation/application/use-cases/installation-service.js";
import type { InstallationOptions } from "../../../src/modules/installation/application/ports/inbound/installation-use-cases.js";
import type { InstallationDependencies } from "../../../src/modules/installation/application/ports/outbound/installation.js";
import type { InstallConfig } from "../../../src/modules/installation/domain/installation.js";
import type { ActivationReceipt, MigrationReceipt } from "../../../src/modules/installation/domain/installation-observations.js";
import { planUpdate } from "../../../src/modules/installation/domain/update-plan.js";
import type { UpdateReceipt, UpdateRequest } from "@palmagent/shared/updates";

const options: InstallationOptions = {
  dryRun: false, interactive: false, force: false, purge: false, pull: true, pluginManifests: [],
};
const request: UpdateRequest = {
  id: "request-1", channel: "preview", automatic: true,
  currentVersion: "0.1.0-alpha.1", targetVersion: "0.1.0-alpha.2",
};

/** All side effects are in-memory port implementations. No environment, files, global mocks or processes. */
function fixture() {
  const calls: string[] = [];
  const receipts: UpdateReceipt[] = [];
  const activations: ActivationReceipt[] = [];
  let migration: MigrationReceipt | undefined;
  const current: InstallConfig = {
    mode: "package", releaseChannel: "preview", user: "owner", group: "owner",
    dataDir: "/installation", dbPath: "/installation/database", runnerSocket: "/installation/runner",
    pkgDir: "/releases/previous", workingDir: "/releases/previous", executionNode: "/runtimes/node",
    supervisor: "palmagentd", daemonScope: "user", execPath: "/bin",
    domain: "app.example.com", host: "localhost", port: 4100, concurrency: 2,
    rpId: "app.example.com", rpName: "Palmagent", authOrigin: "https://app.example.com",
    pushSubject: "", repoRoots: "", claudeConfigDir: "",
    caps: { memHigh: "1G", memMax: "2G", tasksMaxRunner: 10, tasksMaxWeb: 10, cpuQuota: "100%", nofile: 1000 },
  };
  const candidate = { ...current, pkgDir: "/releases/candidate", workingDir: "/releases/candidate" };
  const remember = (name: string) => { calls.push(name); };
  const deps: InstallationDependencies = {
    configuration: {
      exists: () => false,
      load: () => ({ ...current }), resolve: async () => ({ ...current }),
      save: config => { remember(`save:${config.pkgDir}`); return "/installation/install.env"; },
      preferences: () => ({ channel: "preview", autoUpdate: true }),
      persistChannel: () => remember("preferences:channel"), initializePreferences: () => remember("preferences:init"),
      assertPurgeTarget: () => remember("purge:validate"),
    },
    state: {
      lock: () => { remember("lock"); return () => remember("unlock"); },
      beginMaintenance: () => { remember("maintenance:begin"); return () => remember("maintenance:end"); },
      parentOwnsMaintenance: () => true,
      readUpdate: () => receipts.at(-1),
      writeUpdate: (_dir, receipt) => {
        receipts.push({ schemaVersion: 1, checkedAt: "2026-01-01T00:00:00.000Z", ...receipt });
        remember(`receipt:${receipt.status}:${receipt.reason}`);
      },
      clearDiscovery: () => remember("discovery:clear"), validRequest: () => true,
      clearRequest: () => remember("request:clear"),
      readMigration: () => migration,
      writeMigration: (_config, receipt) => { migration = receipt; remember("migration:write"); },
      clearMigration: () => { migration = undefined; remember("migration:clear"); },
      writeActivation: (_config, receipt) => { activations.push(receipt); remember(`activation:${receipt.status}`); },
    },
    runtime: {
      assertIdentity: () => remember("identity"), assertOwner: () => remember("owner"),
      assertBootstrapSupported: () => {}, canManageServices: () => true, preflight: () => [],
      prepareUserService: (_config, dryRun) => remember(dryRun ? "user:preview" : "user:prepare"),
      verifyUserIsolation: () => remember("user:isolation"), retainRelease: () => remember("release:retain"),
      prepareSetup: () => { remember("setup:plan"); return { summary: ["prepared setup"], apply: () => remember("setup:apply") }; },
      configure: (_config, dryRun) => { remember(dryRun ? "runtime:preview" : "runtime:configure"); return { runnerChanged: false }; },
      artifactChanged: () => false, installBootstrap: () => remember("bootstrap:install"),
      start: async () => remember("runtime:start"), restartRunner: () => remember("runner:restart"),
      restartWeb: async config => remember(`web:restart:${config.pkgDir}`), healthy: () => true,
      waitHealthy: async config => { remember(`health:${config.pkgDir}`); return true; },
      activity: async () => ({ verified: true, healthy: true, maintenance: true, executionProtocol: 1, activeRoutineScripts: 0, updateBlockingRoutineScripts: 0 }),
      legacyIdle: async () => true, verifyCompatibility: () => remember("compatibility"),
      assertExecutionsFinished: () => remember("executions:idle"),
      configureAutoUpdate: async () => remember("auto:configure"), retireAutoUpdateTimer: () => remember("auto:retire"),
      serviceDescription: () => "runtime", healthFailureHint: () => "runtime unhealthy",
      validateCandidate: () => remember("candidate:validate"), snapshotDaemonConfig: () => "previous configuration",
      configureDaemon: () => remember("daemon:configure"), stopPrevious: async () => remember("previous:stop"),
      restoreBootstrap: () => remember("bootstrap:restore"), removeCandidate: async () => remember("candidate:remove"),
      restorePrevious: async () => remember("previous:restore"), finishMigration: () => remember("migration:finish"),
      removeServices: async () => remember("services:remove"), purge: () => remember("data:purge"),
      retainedCandidate: () => candidate,
      provisionCandidate: config => remember(`provision:${config.pkgDir}`), isPostUpgrade: () => false,
    },
    releases: {
      installedVersion: directory => directory === candidate.pkgDir ? "0.1.0-alpha.2" : "0.1.0-alpha.1",
      stage: () => { remember("release:stage"); return { ...candidate }; },
      identity: () => ({ version: "0.1.0-alpha.2", sourceCommit: "a".repeat(40), files: { "/": "hash" } }),
      verifyCli: () => remember("cli:verify"), verifyApplication: async () => remember("application:verify"),
      globalPrefix: () => "/prefix", installGlobal: () => { remember("package:replace"); return true; },
      activateInstalled: () => remember("installed:activate"),
      readPlugins: () => [], discoverPlugins: () => [], participatingPlugins: () => [],
      resolvePlan: (current, channel, plugins, requested) => planUpdate(current, requested ?? "0.1.0-alpha.2", channel, plugins),
      refreshPlugins: () => [], canonicalPluginPath: path => path,
    },
    feedback: {
      step() {}, info() {}, ok() {}, warn() {}, err() {}, plain() {}, checks() {}, plan() {},
      confirm: async () => true,
    },
    diagnostics: { doctor: () => [], application: async () => [] },
  };
  return { deps, current, candidate, calls, receipts, activations, service: createInstallationService(deps) };
}
function before(calls: string[], earlier: string, later: string) {
  assert(calls.includes(earlier), `missing ${earlier}`);
  assert(calls.indexOf(later) > calls.indexOf(earlier), `${earlier} must precede ${later}: ${calls.join(", ")}`);
}
function fail(message: string): never { throw new Error(message); }

test("preflight and declined confirmation stop before installation effects", async () => {
  const f = fixture();
  f.deps.runtime.preflight = () => [{ name: "host", level: "fail", detail: "unsupported" }];
  assert.equal(await f.service.install(options), false);
  assert.deepEqual(f.calls, ["identity"]);
  f.deps.runtime.preflight = () => [];
  f.deps.feedback.confirm = async () => false;
  assert.equal(await f.service.install({ ...options, interactive: true }), false);
  assert(!f.calls.includes("release:retain"));
  assert(!f.calls.some(call => call.startsWith("save:")));
});

for (const command of ["install", "setup", "update", "uninstall"] as const) {
  test(`${command} preview avoids durable changes and activation`, async () => {
    const f = fixture();
    assert.equal(await f.service[command]({ ...options, dryRun: true, purge: true }), true);
    assert(f.calls.every(call => ["user:preview", "runtime:preview", "setup:plan", "owner", "purge:validate"].includes(call)), f.calls.join(", "));
    assert.equal(f.receipts.length, 0);
    assert.equal(f.activations.length, 0);
  });
}

test("fresh installation saves retained configuration before starting and enabling automatic updates", async () => {
  const f = fixture();
  assert.equal(await f.service.install(options), true);
  before(f.calls, "release:retain", `save:${f.current.pkgDir}`);
  before(f.calls, `save:${f.current.pkgDir}`, "runtime:start");
  before(f.calls, `health:${f.current.pkgDir}`, "auto:configure");
});

test("native setup previews and applies one prepared plan before activating", async () => {
  const f = fixture();
  const output: string[] = [];
  f.deps.feedback.info = line => output.push(line);
  assert.equal(await f.service.setup({ ...options, dryRun: true }), true);
  assert.deepEqual(output, ["[dry-run] prepared setup"]);
  assert(!f.calls.includes("setup:apply"));
  f.calls.length = 0; output.length = 0;
  assert.equal(await f.service.setup(options), true);
  assert.equal(f.calls.filter(call => call === "setup:plan").length, 1);
  before(f.calls, "setup:plan", "user:isolation");
  before(f.calls, "user:isolation", "setup:apply");
  before(f.calls, "setup:apply", `web:restart:${f.current.pkgDir}`);
  assert(!f.calls.includes("runtime:configure"));
  assert(!f.calls.includes("bootstrap:install"));
});

test("install on an existing installation follows setup admission, even with force", async () => {
  const f = fixture();
  f.deps.configuration.exists = () => true;
  f.deps.runtime.activity = async () => ({ verified: true, healthy: true, maintenance: true, executionProtocol: 1, activeRoutineScripts: 1 });
  assert.equal(await f.service.install({ ...options, force: true }), false);
  assert.deepEqual(f.calls.slice(-2), ["maintenance:end", "unlock"]);
  assert(!f.calls.includes("runtime:configure"));
});

for (const unverified of [false, true]) {
  test(`legacy update defers when ${unverified ? "idle state cannot be verified" : "tasks are active"} and retains the pending request`, async () => {
    const f = fixture();
    f.current.executionNode = undefined;
    f.deps.runtime.legacyIdle = async () => unverified ? fail("unreachable") : false;
    assert.equal(await f.service.update({ ...options, automatic: true, request, force: true }), true);
    assert.equal(f.receipts.at(-1)?.reason, unverified ? "idle-state-unverified" : "tasks-active");
    assert(!f.calls.includes("package:replace"));
    assert(!f.calls.includes("request:clear"));
    assert.deepEqual(f.calls.slice(-2), ["maintenance:end", "unlock"]);
  });
}

test("a previous failed attempt holds automatic retries before staging", async () => {
  const f = fixture();
  f.deps.state.writeUpdate(f.current.dataDir, { status: "failed", previousVersion: "0.1.0-alpha.1", targetVersion: "0.1.0-alpha.2", reason: "application-activation-failed" });
  assert.equal(await f.service.update({ ...options, automatic: true }), true);
  assert(!f.calls.includes("release:stage"));
  assert.equal(f.receipts.length, 1);
  assert.equal(f.calls.at(-1), "unlock");
});

test("independent activation checks routine safety under maintenance and keeps a deferred request", async () => {
  const f = fixture();
  f.deps.runtime.activity = async () => {
    assert(f.calls.includes("maintenance:begin"));
    return { verified: true, healthy: true, maintenance: true, executionProtocol: 1, activeRoutineScripts: 1, updateBlockingRoutineScripts: 1 };
  };
  assert.equal(await f.service.update({ ...options, request }), true);
  assert.equal(f.receipts.at(-1)?.reason, "routine-scripts-active");
  assert.equal(f.activations.length, 0);
  assert(!f.calls.some(call => call.startsWith("save:") || call.startsWith("web:restart:")));
  assert(!f.calls.includes("request:clear"));
  assert.deepEqual(f.calls.slice(-2), ["maintenance:end", "unlock"]);
});

test("independent activation records intent before changing runtime and verifies build before success", async () => {
  const f = fixture();
  assert.equal(await f.service.update(options), true);
  before(f.calls, "activation:applying", `provision:${f.candidate.pkgDir}`);
  before(f.calls, `save:${f.candidate.pkgDir}`, `web:restart:${f.candidate.pkgDir}`);
  before(f.calls, "application:verify", "receipt:succeeded:application-and-executions-verified");
  assert.deepEqual(f.activations.map(receipt => receipt.status), ["applying", "succeeded"]);
  assert(!f.calls.includes("runner:restart"));
  assert.deepEqual(f.calls.slice(-2), ["maintenance:end", "unlock"]);
});

for (const restored of [true, false]) {
  test(`failed candidate verification records ${restored ? "restored" : "recovery-required"} after attempting the previous release`, async () => {
    const f = fixture();
    f.deps.releases.verifyApplication = async () => fail("served build mismatch");
    f.deps.runtime.waitHealthy = async config => config.pkgDir === f.candidate.pkgDir || restored;
    assert.equal(await f.service.update(options), false);
    before(f.calls, `provision:${f.current.pkgDir}`, `save:${f.current.pkgDir}`);
    before(f.calls, `save:${f.current.pkgDir}`, `web:restart:${f.current.pkgDir}`);
    assert.equal(f.activations.at(-1)?.status, restored ? "restored" : "recovery-required");
    assert.equal(f.receipts.at(-1)?.status, "failed");
    assert.deepEqual(f.calls.slice(-2), ["maintenance:end", "unlock"]);
  });
}

test("changed automatic-update settings prevent candidate activation", async () => {
  const f = fixture();
  let reads = 0;
  f.deps.configuration.preferences = () => ({ channel: "preview", autoUpdate: ++reads < 3 });
  assert.equal(await f.service.update({ ...options, automatic: true }), true);
  assert.equal(f.receipts.at(-1)?.reason, "settings-changed");
  assert.equal(f.activations.length, 0);
});

test("manual recovery can reactivate the same version after a failed application update", async () => {
  const f = fixture();
  f.deps.state.writeUpdate(f.current.dataDir, { status: "failed", previousVersion: "0.1.0-alpha.1", targetVersion: "0.1.0-alpha.1", reason: "application-activation-failed" });
  f.deps.releases.resolvePlan = (current, channel, plugins) => planUpdate(current, current, channel, plugins);
  assert.equal(await f.service.update(options), true);
  assert(f.calls.includes("release:stage"));
  assert.equal(f.receipts.at(-1)?.status, "succeeded");
});

test("migration failure restores the previous listener only after candidate removal", async () => {
  const f = fixture();
  f.current.daemonScope = "system";
  f.deps.configuration.resolve = async () => ({ ...f.current, daemonScope: "user" });
  f.deps.runtime.waitHealthy = async config => config.daemonScope === "system";
  await assert.rejects(f.service.setup(options), /Daemon migration health check failed/);
  before(f.calls, "candidate:remove", "previous:restore");
  before(f.calls, "previous:restore", "migration:clear");
  assert(!f.calls.includes("migration:finish"));
  assert.deepEqual(f.calls.slice(-2), ["maintenance:end", "unlock"]);
});

test("unverified candidate shutdown retains migration evidence without restoring a second listener", async () => {
  const f = fixture();
  f.current.daemonScope = "system";
  f.deps.configuration.resolve = async () => ({ ...f.current, daemonScope: "user" });
  f.deps.runtime.waitHealthy = async () => false;
  f.deps.runtime.removeCandidate = async () => fail("shutdown unverified");
  await assert.rejects(f.service.setup(options), /daemon shutdown could not be verified/);
  assert(!f.calls.includes("previous:restore"));
  assert(!f.calls.includes("migration:clear"));
  assert(f.deps.state.readMigration(f.current));
  assert.deepEqual(f.calls.slice(-2), ["maintenance:end", "unlock"]);
});

test("post-upgrade activation requires the live parent's barrier as well as the sentinel", async () => {
  const f = fixture();
  f.deps.runtime.isPostUpgrade = () => true;
  f.deps.state.parentOwnsMaintenance = () => false;
  await assert.rejects(f.service.update({ ...options, pull: false, expectedVersion: "0.1.0-alpha.1" }), /live parent's maintenance window/);
  assert(!f.calls.includes("runtime:configure"));
});

test("uninstall refuses active executions before removing services or purging data", async () => {
  const f = fixture();
  f.deps.runtime.assertExecutionsFinished = () => fail("active terminal");
  await assert.rejects(f.service.uninstall({ ...options, purge: true }), /active terminal/);
  assert(!f.calls.includes("services:remove"));
  assert(!f.calls.includes("data:purge"));
  assert.equal(f.calls.at(-1), "maintenance:end");
});

test("uninstall preserves data when the separate purge confirmation is declined", async () => {
  const f = fixture();
  let confirmations = 0;
  f.deps.feedback.confirm = async () => ++confirmations === 1;
  assert.equal(await f.service.uninstall({ ...options, interactive: true, purge: true }), true);
  assert(f.calls.includes("services:remove"));
  assert(!f.calls.includes("data:purge"));
  assert.equal(confirmations, 2);
});
