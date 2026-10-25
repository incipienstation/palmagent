import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { InstallConfig } from "../../domain/installation.js";
import type { PreparedSetup } from "../../application/ports/outbound/installation.js";
import { installEnvPath, parseEnvFile, renderInstallConfig } from "./config.js";
import { daemonConfiguration, writeDaemonConfiguration } from "./daemon-runtime.js";
import { daemonUnitPath, installDaemonBootstrap, renderDaemonBootstrap } from "./daemon-bootstrap.js";
import { writePrivateFileAtomic } from "../../../../platform/filesystem/private-files.js";

function readOptional(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

const digest = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

function fingerprint(path: string): string | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  const content = stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path);
  return `${stat.mode}:${stat.uid}:${stat.gid}:${digest(content)}`;
}

/** One candidate supplies both preview and application. Never print environment values. */
export function prepareNativeSetup(cfg: InstallConfig): PreparedSetup {
  if (cfg.supervisor !== "palmagentd" || cfg.daemonScope !== "user") throw new Error("Native setup planning requires a user daemon installation");
  const installPath = installEnvPath(cfg.dataDir), daemonPath = join(cfg.dataDir, "daemon", "config.json");
  const current = join(cfg.dataDir, "daemon", "current"), launcher = join(cfg.dataDir, "daemon", "launcher");
  const fingerprints = [installPath, daemonPath, daemonUnitPath(cfg), current, launcher].map(path => ({ path, before: fingerprint(path) }));
  const assertUnchanged = () => {
    for (const { path, before } of fingerprints) {
      if (fingerprint(path) !== before) throw new Error(`Setup input changed after planning: ${path}; rerun setup`);
    }
  };
  const configuration = daemonConfiguration(cfg);
  const bootstrap = renderDaemonBootstrap(cfg);
  const installText = renderInstallConfig(cfg), daemonText = JSON.stringify(configuration) + "\n";
  const previousInstall = readOptional(installPath), previousDaemon = readOptional(daemonPath);
  const files = [
    { path: installPath, before: previousInstall, after: installText },
    { path: daemonPath, before: previousDaemon, after: daemonText },
    { path: bootstrap.path, before: readOptional(bootstrap.path), after: bootstrap.text },
  ];
  const summary = files.map(file => `${file.before === file.after ? "preserve" : file.before === undefined ? "create" : "update"} ${file.path} (SHA-256: ${file.before === undefined ? "absent" : digest(file.before)} -> ${digest(file.after)})`);
  const beforeFields = previousInstall ? parseEnvFile(previousInstall) : {};
  const afterFields = parseEnvFile(installText);
  const changed = [...new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])].filter(key => beforeFields[key] !== afterFields[key]);
  if (changed.length) summary.push(`Installation fields: ${changed.join(", ")}`);
  for (const key of ["HOST", "PORT", "DISPATCH_CONCURRENCY", "SUPERVISOR", "DAEMON_SCOPE"]) {
    if (changed.includes(key)) summary.push(`${key}: ${JSON.stringify(beforeFields[key] ?? null)} -> ${JSON.stringify(afterFields[key] ?? null)}`);
  }
  const previous = previousDaemon ? JSON.parse(previousDaemon) as ReturnType<typeof daemonConfiguration> : undefined;
  const runtimeChanges: string[] = [];
  for (const key of ["protocol", "daemon", "release", "node", "isolation"] as const) {
    if (previous?.[key] !== configuration[key]) runtimeChanges.push(key);
  }
  for (const group of ["environment", "limits"] as const) {
    const before = previous?.[group] as Record<string, unknown> | undefined;
    const after = configuration[group] as Record<string, unknown>;
    for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after)])) {
      if (before?.[key] !== after[key]) runtimeChanges.push(`${group}.${key}`);
    }
  }
  if (runtimeChanges.length) summary.push(`Runtime fields: ${runtimeChanges.join(", ")}`);
  let oldOrigin = "not configured";
  if (previous?.environment.AUTH_ORIGIN) {
    try {
      const url = new URL(previous.environment.AUTH_ORIGIN);
      oldOrigin = url.protocol === "https:" && !url.username && !url.password && url.origin === previous.environment.AUTH_ORIGIN
        ? url.origin : "invalid (redacted)";
    } catch { oldOrigin = "invalid (redacted)"; }
  }
  summary.push(`Public origin: ${oldOrigin} -> ${cfg.authOrigin}`);
  summary.push("Saved provider, proxy, CA and locale settings are retained; environment values are omitted.");
  let selectionChanged = false;
  for (const [path, target] of [[current, configuration.daemon], [launcher, "current"]]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (path === launcher && !stat) continue;
    const unchanged = stat?.isSymbolicLink() && readlinkSync(path) === target;
    selectionChanged ||= !unchanged;
    summary.push(`${unchanged ? "preserve" : "select"} ${path} -> ${target}`);
  }
  summary.push("Reload the user service manager to load the prepared bootstrap unit.");
  summary.push(`Ensure bootstrap ${bootstrap.unit} is enabled.`);
  summary.push("Replace the daemon and restart the web application; retain independent executions and terminals, then verify health.");
  assertUnchanged();
  return {
    summary,
    apply() {
      assertUnchanged();
      if (previousInstall !== installText) writePrivateFileAtomic(installPath, installText);
      if (previousDaemon !== daemonText || selectionChanged) writeDaemonConfiguration(cfg.dataDir, configuration);
      installDaemonBootstrap(cfg, true, bootstrap);
    },
  };
}
