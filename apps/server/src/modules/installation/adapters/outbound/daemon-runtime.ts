import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { DAEMON_PROTOCOL, DaemonConfigurationSchema, DaemonStatusSchema } from "@palmagent/shared/daemon";
import { ensurePrivateDirectory, writePrivateFileAtomic } from "../../../../platform/filesystem/private-files.js";
import { daemonRequest } from "../../../../platform/process/daemon-client.js";
import type { InstallConfig } from "./config.js";
import { userConfigPath } from "./user-config.js";


/** Native artifacts are bundled for every supported package architecture, with no install script. */
export function daemonBinary(release: string, platform = process.platform, arch = process.arch): string {
  const name = `${platform}-${arch}`;
  const manifest = JSON.parse(readFileSync(join(release, "daemon", "manifest.json"), "utf8"));
  if (manifest.protocol !== DAEMON_PROTOCOL || typeof manifest.artifacts?.[name] !== "string") throw new Error("This package has no compatible daemon for the host");
  const binary = join(release, "daemon", name, "palmagentd");
  const digest = createHash("sha256").update(readFileSync(binary)).digest("hex");
  if (digest !== manifest.artifacts[name]) throw new Error("Daemon artifact integrity mismatch");
  return binary;
}

function memoryBytes(value: string): number {
  const match = /^(\d+)([KMGT])?$/.exec(value);
  if (!match) throw new Error("Daemon memory caps must be bytes or an integer with K, M, G, T suffix");
  const bytes = Number(match[1]) * 1024 ** (match[2] ? "KMGT".indexOf(match[2]) + 1 : 0);
  if (!Number.isSafeInteger(bytes)) throw new Error("Invalid memory cap");
  return bytes;
}

export function daemonConfiguration(cfg: InstallConfig) {
  if (!cfg.pkgDir || !cfg.executionNode || cfg.supervisor !== "palmagentd") throw new Error("A retained daemon installation is required");
  const user = userInfo();
  if (cfg.user !== user.username || cfg.user === "root") throw new Error("Daemon configuration requires the installation owner");
  const environment: Record<string, string> = {
    HOME: user.homedir, USER: cfg.user, LOGNAME: cfg.user, PATH: cfg.execPath,
    NODE_ENV: "production", DISABLE_AUTOUPDATER: "1", HOST: cfg.host, PORT: String(cfg.port),
    DISPATCH_CONCURRENCY: String(cfg.concurrency), PALMAGENT_EXECUTION_CONCURRENCY: String(cfg.concurrency),
    DISPATCHER_DB: cfg.dbPath, DISPATCHER_DATA_DIR: cfg.dataDir, PALMAGENT_HOME: dirname(userConfigPath()),
    EXECUTION_RELEASE: cfg.pkgDir, EXECUTION_NODE: cfg.executionNode, STATIC_DIR: join(cfg.pkgDir, "web"),
    AUTH_RP_ID: cfg.rpId, AUTH_RP_NAME: cfg.rpName, AUTH_ORIGIN: cfg.authOrigin,
  };
  for (const key of ["LANG", "LC_ALL", "CODEX_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) {
    if (process.env[key]) environment[key] = process.env[key]!;
  }
  if (cfg.claudeConfigDir) environment.CLAUDE_CONFIG_DIR = cfg.claudeConfigDir;
  if (cfg.repoRoots) environment.REPO_ROOTS = cfg.repoRoots;
  if (cfg.pushSubject) environment.PUSH_SUBJECT = cfg.pushSubject;
  if (!/^\d+%$/.test(cfg.caps.cpuQuota)) throw new Error("Daemon CPU cap must be a positive integer percentage");
  return DaemonConfigurationSchema.parse({
    protocol: DAEMON_PROTOCOL, daemon: daemonBinary(cfg.pkgDir), release: realpathSync(cfg.pkgDir), node: realpathSync(cfg.executionNode),
    environment, isolation: "cgroup", limits: {
      memoryHigh: memoryBytes(cfg.caps.memHigh), memoryMax: memoryBytes(cfg.caps.memMax), tasks: cfg.caps.tasksMaxRunner,
      webTasks: cfg.caps.tasksMaxWeb, cpuPercent: Number(cfg.caps.cpuQuota.slice(0, -1)), nofile: cfg.caps.nofile,
    },
  });
}

/** Normal activation mutates only user-owned state. Bootstrap registration is separate. */
export function configureDaemon(cfg: InstallConfig): void {
  const configuration = daemonConfiguration(cfg);
  const directory = join(cfg.dataDir, "daemon");
  ensurePrivateDirectory(directory);
  writePrivateFileAtomic(join(directory, "config.json"), JSON.stringify(configuration) + "\n");
}

export function daemonStatus(cfg: InstallConfig) { return DaemonStatusSchema.parse(daemonRequest(cfg.dataDir, { action: "status" })); }

export function activateDaemon(cfg: InstallConfig, replace = true): void {
  configureDaemon(cfg);
  if (replace) {
    const prior = daemonStatus(cfg);
    daemonRequest(cfg.dataDir, { action: "replace" });
    // Replacement preserves the bootstrap PID. Verify the new binary identity before changing web.
    const expected = JSON.parse(readFileSync(join(cfg.pkgDir!, "build-info.json"), "utf8"));
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const status = daemonStatus(cfg);
        if (status.instance !== prior.instance && status.version === expected.version && status.sourceCommit === expected.sourceCommit) { ready = true; break; }
      } catch { /* CLOEXEC briefly removes the control endpoint. */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (!ready) throw new Error("Replacement daemon identity could not be verified");
  }
  daemonRequest(cfg.dataDir, { action: "restart-web" });
}
