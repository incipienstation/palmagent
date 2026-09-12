// install / setup / update / uninstall orchestration. This is the only code
// that mutates the host (systemd units, nginx, certbot, the SQLite db). Every
// mutating step is gated behind --dry-run (render + print, touch nothing) so the
// flow is inspectable and CI-testable; real mutations need sudo.
//
// These commands are the packaged install/update path. Source mode supports a
// checked-out maintainer build, but public self-update is package-only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { BRANDING } from "@palmagent/shared";
import {
  assertSafeInstallerIdentity,
  assertSafePurgeTarget,
  authFromDomain,
  callerPkgDir,
  type InstallConfig,
  loadConfig,
  resolveDataDir,
  saveConfig,
  validateInstallInput,
} from "./config.js";
import {
  channelTag,
  compatiblePlugin,
  productVersion,
  validateUpdateTarget,
} from "./release-policy.js";
import { assertUserConfigPreserved, getUserConfig, initUserConfig, setUserChannel, userConfigPath } from "./user-config.js";
import { readPluginVersions, resolveUpdatePlan } from "./update-plan.js";
import { acquireUpdateLock, readUpdateReceipt, writeUpdateReceipt } from "./update-state.js";
import { beginUpdateMaintenance } from "../update-maintenance.js";
import { verifyUpdateIdle } from "./update-idle.js";
import { configureAutoUpdate, removeAutoUpdateTimer } from "./auto-update.js";
import { preflight, doctor, printChecks } from "./checks.js";
import { renderNginx } from "./nginx.js";
import {
  recordRunnerArtifact,
  runnerArtifactChanged,
} from "./runner-state.js";
import { renderUnits, runnerUnitName, webUnitName } from "./units.js";
import {
  ask,
  canSudoNonInteractive,
  confirm,
  log,
  run,
  sudo,
  sudoWriteFile,
  which,
} from "./sh.js";

export interface Flags {
  dryRun: boolean;
  nonInteractive: boolean;
  force: boolean;
  purge: boolean;
  pull: boolean;
  plan?: boolean;
  automatic?: boolean;
  get(key: string): string | undefined;
  getAll?(key: string): string[];
}

export function loadInstalledConfig(flags: Flags): InstallConfig {
  return loadConfig({
    dataDir: flags.get("data-dir"),
    requireInstalled: true,
  });
}

export function postUpgradeArgs(
  cfg: InstallConfig,
  flags: Flags,
): string[] {
  return [
    "update",
    "--data-dir",
    cfg.dataDir,
    ...(flags.get("channel") ? ["--channel", cfg.releaseChannel!] : []),
    ...(flags.nonInteractive ? ["-y"] : []),
  ];
}

function persistUserChannel(cfg: InstallConfig, flags: Flags): void {
  if (flags.get("channel") !== undefined) setUserChannel(cfg.releaseChannel!);
  else initUserConfig({ dataDir: cfg.dataDir });
}

const SYSTEMD_DIR = "/etc/systemd/system";
const NGINX_CONFD = "/etc/nginx/conf.d";
const NGINX_SITES_AVAIL = "/etc/nginx/sites-available";
const NGINX_SITES_ENABLED = "/etc/nginx/sites-enabled";

// ----------------------------------------------------------------- run mode
function detectRuntime(): {
  mode: "package" | "source";
  pkgDir?: string;
  repoDir?: string;
} {
  const dir = callerPkgDir();
  if (existsSync(join(dir, "server.js")))
    return { mode: "package", pkgDir: dir };
  // tsx/source: cli is at <repo>/apps/server/src/cli → repo root is 4 up
  const repoDir = resolve(dir, "..", "..", "..", "..");
  if (existsSync(join(repoDir, "apps", "server", "package.json")))
    return { mode: "source", repoDir };
  return { mode: "package", pkgDir: dir };
}

// ------------------------------------------------------------- gather config
export async function gatherConfig(
  flags: Flags,
  requireInstalled = false,
): Promise<InstallConfig> {
  const rt = detectRuntime();
  const dataDir = resolveDataDir(flags.get("data-dir"));
  // Start from any existing config (so re-runs are idempotent), then override.
  const base = loadConfig({
    dataDir,
    pkgDir: rt.pkgDir,
    requireInstalled,
  });

  const domainInput =
    flags.get("domain") ??
    (flags.nonInteractive
      ? base.domain
      : await ask("Public domain (e.g. dispatch.example.com)", base.domain));
  if (!domainInput) {
    throw new Error(
      "a public domain is required — pass --domain or enter it at the prompt (no default).",
    );
  }
  const portInput = Number(
    flags.get("port") ??
      (flags.nonInteractive
        ? base.port
        : await ask("Internal port", String(base.port))),
  );
  const concurrencyInput = Number(
    flags.get("concurrency") ??
      (flags.nonInteractive
        ? base.concurrency
        : await ask("Max concurrent turns", String(base.concurrency))),
  );
  const repoRoots =
    flags.get("repo-roots") ??
    (flags.nonInteractive
      ? base.repoRoots
      : await ask(
          "Repo scan roots (colon-separated, blank = ~/code)",
          base.repoRoots,
        ));
  const claudeConfigDir =
    flags.get("claude-config-dir") ??
    (flags.nonInteractive
      ? base.claudeConfigDir
      : await ask(
          "Claude CLI config dir (CLAUDE_CONFIG_DIR, blank = ~/.claude default)",
          base.claudeConfigDir,
        ));
  const input = validateInstallInput({
    domain: domainInput,
    host: flags.get("host") ?? base.host,
    port: portInput,
    concurrency: concurrencyInput,
    pushSubject: flags.get("push-subject") ?? base.pushSubject,
  });

  const requestedChannel = flags.get("channel");
  const selectedChannel = requestedChannel !== undefined
    ? setUserChannel(requestedChannel, { dryRun: true }).channel
    : getUserConfig({ dataDir }).channel;
  if (!requireInstalled && rt.mode === "package" && selectedChannel === "stable" &&
      productVersion(installedVersion(rt.pkgDir)).prerelease) {
    throw new Error("this is a Preview build; opt in with --channel preview or install a published Stable release");
  }

  const cfg: InstallConfig = {
    ...base,
    releaseChannel: selectedChannel,
    mode: rt.mode,
    pkgDir: rt.pkgDir,
    repoDir: rt.repoDir,
    workingDir:
      rt.mode === "source" ? join(rt.repoDir!, "apps", "server") : rt.pkgDir!,
    dataDir,
    runnerSocket: join(dataDir, "runner.sock"),
    dbPath: base.dbPath,
    domain: input.domain,
    host: input.host,
    port: input.port,
    concurrency: input.concurrency,
    pushSubject: input.pushSubject,
    repoRoots,
    claudeConfigDir,
    ...authFromDomain(input.domain),
  };
  return cfg;
}

// ---------------------------------------------------------------- write units
function applyUnits(
  cfg: InstallConfig,
  flags: Flags,
): { runnerChanged: boolean } {
  const units = renderUnits(cfg);
  const webPath = join(SYSTEMD_DIR, units.web.name);
  const runnerPath = join(SYSTEMD_DIR, units.runner.name);

  // Restart only when the runner unit or executable artifact changed (or it is
  // not installed), so in-flight turns survive a web-only update.
  let installedRunner: string | undefined;
  try {
    installedRunner = readFileSync(runnerPath, "utf8");
  } catch {
    // Missing or unreadable means the unit must be installed.
  }
  const runnerChanged = installedRunner !== units.runner.text;

  if (flags.dryRun) {
    log.info(`[dry-run] would write ${webPath} and ${runnerPath}`);
    log.info(
      `[dry-run] runner ${runnerChanged ? "CHANGED → would restart" : "unchanged → would leave running"}`,
    );
    log.plain(`\n# ${runnerPath}\n${units.runner.text}`);
    log.plain(`\n# ${webPath}\n${units.web.text}`);
    return { runnerChanged };
  }

  if (!sudoWriteFile(runnerPath, units.runner.text))
    throw new Error(`failed to write ${runnerPath}`);
  if (!sudoWriteFile(webPath, units.web.text))
    throw new Error(`failed to write ${webPath}`);
  const reloaded = sudo(["systemctl", "daemon-reload"]);
  if (!reloaded.ok) throw new Error(`systemd daemon-reload failed:\n${reloaded.stderr}`);
  const enabled = sudo(["systemctl", "enable", units.runner.name, units.web.name]);
  if (!enabled.ok) throw new Error(`failed to enable Palmagent units:\n${enabled.stderr}`);
  return { runnerChanged };
}

// ---------------------------------------------------------------- write nginx
type PathSnapshot =
  | { kind: "missing" }
  | { kind: "file"; content: string }
  | { kind: "symlink"; target: string };

function snapshotPath(path: string): PathSnapshot {
  const link = sudo(["readlink", path]);
  if (link.ok) return { kind: "symlink", target: link.stdout.trim() };
  const file = sudo(["cat", path]);
  return file.ok ? { kind: "file", content: file.stdout } : { kind: "missing" };
}

function restorePath(path: string, snapshot: PathSnapshot): void {
  sudo(["rm", "-f", path]);
  if (snapshot.kind === "file" && !sudoWriteFile(path, snapshot.content)) {
    throw new Error(`failed to restore ${path}`);
  }
  if (
    snapshot.kind === "symlink" &&
    !sudo(["ln", "-s", snapshot.target, path]).ok
  ) {
    throw new Error(`failed to restore symlink ${path}`);
  }
}

function backupNginxFiles(
  cfg: InstallConfig,
  snapshots: Map<string, PathSnapshot>,
): void {
  const dir = join(cfg.dataDir, "nginx-last-good");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [path, snapshot] of snapshots) {
    if (snapshot.kind === "file")
      writeFileSync(join(dir, basename(path)), snapshot.content, {
        mode: 0o600,
      });
    if (snapshot.kind === "symlink")
      writeFileSync(
        join(dir, `${basename(path)}.symlink`),
        `${snapshot.target}\n`,
        { mode: 0o600 },
      );
  }
}

function assertNginxValid(): void {
  const tested = sudo(["nginx", "-t"]);
  if (!tested.ok) throw new Error(`nginx config invalid:\n${tested.stderr}`);
}

function reloadNginx(): void {
  const reloaded = sudo(["systemctl", "reload", "nginx"]);
  if (!reloaded.ok) throw new Error(`nginx reload failed:\n${reloaded.stderr}`);
}

function rollbackNginx(snapshots: Map<string, PathSnapshot>): void {
  for (const [path, snapshot] of [...snapshots].reverse())
    restorePath(path, snapshot);
  assertNginxValid();
  reloadNginx();
}

function applyNginx(cfg: InstallConfig, flags: Flags): void {
  const ng = renderNginx(cfg);
  const useSites = existsSync(NGINX_SITES_AVAIL);
  const vhostPath = useSites
    ? join(NGINX_SITES_AVAIL, ng.vhost.name)
    : join(NGINX_CONFD, ng.vhost.name);
  const zonesPath = join(NGINX_CONFD, ng.zones.name);
  const enabledPath = useSites
    ? join(NGINX_SITES_ENABLED, ng.vhost.name)
    : undefined;

  if (flags.dryRun) {
    log.info(`[dry-run] would write ${zonesPath} and ${vhostPath}`);
    log.info(
      "[dry-run] would require a valid TLS certificate before activating the HTTPS vhost",
    );
    log.info(
      "[dry-run] if absent, would use the ACME-only bootstrap without proxying the application over HTTP",
    );
    log.plain(`\n# ${zonesPath}\n${ng.zones.text}`);
    log.plain(`\n# ${vhostPath}\n${ng.vhost.text}`);
    log.plain(`\n# temporary ACME bootstrap\n${ng.bootstrap.text}`);
    return;
  }

  assertNginxValid();
  const paths = [zonesPath, vhostPath, ...(enabledPath ? [enabledPath] : [])];
  const snapshots = new Map(paths.map((path) => [path, snapshotPath(path)]));
  backupNginxFiles(cfg, snapshots);

  try {
    if (!sudoWriteFile(zonesPath, ng.zones.text))
      throw new Error(`failed to write ${zonesPath}`);
    if (!sudoWriteFile(vhostPath, ng.vhost.text))
      throw new Error(`failed to write ${vhostPath}`);
    if (enabledPath && !sudo(["ln", "-sfn", vhostPath, enabledPath]).ok) {
      throw new Error(`failed to enable ${vhostPath}`);
    }
    assertNginxValid();
    reloadNginx();
  } catch (error) {
    rollbackNginx(snapshots);
    throw error;
  }
  log.ok("HTTPS-only nginx vhost applied");
}

function tlsCertificateUsable(cfg: InstallConfig): boolean {
  const cert = `/etc/letsencrypt/live/${cfg.domain}/fullchain.pem`;
  const key = `/etc/letsencrypt/live/${cfg.domain}/privkey.pem`;
  return (
    sudo(["test", "-s", key]).ok &&
    sudo([
      "openssl",
      "x509",
      "-checkend",
      "0",
      "-checkhost",
      cfg.domain,
      "-noout",
      "-in",
      cert,
    ]).ok
  );
}

function ensureTlsCertificate(cfg: InstallConfig, flags: Flags): void {
  if (flags.dryRun) {
    log.info(
      `[dry-run] would verify or obtain a valid TLS certificate for ${cfg.domain}`,
    );
    return;
  }
  if (tlsCertificateUsable(cfg)) {
    log.ok(`TLS cert already present for ${cfg.domain}`);
    return;
  }

  const ng = renderNginx(cfg);
  const useSites = existsSync(NGINX_SITES_AVAIL);
  const bootstrapPath = useSites
    ? join(NGINX_SITES_AVAIL, ng.bootstrap.name)
    : join(NGINX_CONFD, ng.bootstrap.name);
  const enabledPath = useSites
    ? join(NGINX_SITES_ENABLED, ng.bootstrap.name)
    : undefined;
  const paths = [bootstrapPath, ...(enabledPath ? [enabledPath] : [])];
  const snapshots = new Map(paths.map((path) => [path, snapshotPath(path)]));

  log.info(`obtaining TLS cert for ${cfg.domain} …`);
  try {
    if (!sudoWriteFile(bootstrapPath, ng.bootstrap.text))
      throw new Error(`failed to write ${bootstrapPath}`);
    if (enabledPath && !sudo(["ln", "-sfn", bootstrapPath, enabledPath]).ok) {
      throw new Error(`failed to enable ${bootstrapPath}`);
    }
    assertNginxValid();
    reloadNginx();

    const issued = sudo([
      "certbot",
      "certonly",
      "--nginx",
      "-d",
      cfg.domain,
      "--non-interactive",
      "--agree-tos",
      "--register-unsafely-without-email",
      "--force-renewal",
    ]);
    if (!issued.ok)
      throw new Error(`certbot did not complete:\n${issued.stderr}`);
  } finally {
    for (const [path, snapshot] of [...snapshots].reverse())
      restorePath(path, snapshot);
    assertNginxValid();
    reloadNginx();
  }

  if (!tlsCertificateUsable(cfg))
    throw new Error(
      `certbot did not produce a valid TLS certificate for ${cfg.domain}`,
    );
  log.ok("TLS cert obtained");
}

/** Mint + print a first-passkey enroll link (ports scripts/register-passkey.ts).
 * Db/AuthService are imported lazily so the native better-sqlite3 binding only
 * loads when actually enrolling — `doctor`/`--help` never trigger it. */
async function enrollPasskey(cfg: InstallConfig, flags: Flags): Promise<void> {
  if (flags.dryRun) {
    log.info("[dry-run] would mint a first-passkey enroll link");
    return;
  }
  try {
    const { Db } = await import("../db.js");
    const { AuthService } = await import("../auth.js");
    const db = new Db(cfg.dbPath);
    const auth = new AuthService(db);
    const { token, expiresAt } = auth.mintEnrollToken();
    db.close();
    log.ok("First-passkey enroll link (single-use, 15 min):");
    log.plain(`\n    ${cfg.authOrigin}/#/enroll/${token}\n`);
    log.info(
      `expires ${new Date(expiresAt).toISOString()} — open it on the device you want to register`,
    );
  } catch (e) {
    log.warn(
      `could not mint enroll token: ${(e as Error).message}. Run \`${BRANDING.cliName} passkey\` later.`,
    );
  }
}

function waitForRunner(cfg: InstallConfig): void {
  for (let i = 0; i < 15; i++) {
    const active = run("systemctl", [
      "is-active",
      "--quiet",
      runnerUnitName(),
    ]).ok;
    if (active && existsSync(cfg.runnerSocket)) return;
    run("sleep", ["1"]);
  }
  throw new Error(
    `runner did not become active at ${cfg.runnerSocket}; see journalctl -u ${runnerUnitName()} -n 50`,
  );
}

function restartRunner(cfg: InstallConfig): void {
  const restarted = sudo(["systemctl", "restart", runnerUnitName()]);
  if (!restarted.ok)
    throw new Error(`failed to restart ${runnerUnitName()}:\n${restarted.stderr}`);
  waitForRunner(cfg);
  recordRunnerArtifact(cfg);
}

function restartWeb(): void {
  const restarted = sudo(["systemctl", "restart", webUnitName()]);
  if (!restarted.ok)
    throw new Error(`failed to restart ${webUnitName()}:\n${restarted.stderr}`);
}

function startServices(cfg: InstallConfig): void {
  const units = renderUnits(cfg);
  if (units.runner.name !== runnerUnitName() || units.web.name !== webUnitName()) {
    throw new Error("rendered unit names do not match the installed Palmagent units");
  }
  restartRunner(cfg);
  restartWeb();
}

function runtimeIsHealthy(cfg: InstallConfig, expectedVersion?: string): boolean {
  const r = run("curl", ["--max-time", "5", "-fsS", `http://${cfg.host}:${cfg.port}/api/health`]);
  if (!r.ok) return false;
  try {
    const health = JSON.parse(r.stdout);
    return health.ok === true && (!expectedVersion || health.build?.version === expectedVersion);
  } catch { return false; }
}

async function healthcheck(cfg: InstallConfig, expectedVersion?: string): Promise<boolean> {
  // Host-local transport stays on loopback. Every browser-facing origin is
  // HTTPS-only through the generated nginx vhost.
  for (let i = 0; i < 30; i++) {
    if (runtimeIsHealthy(cfg, expectedVersion)) return true;
    run("sleep", ["1"]);
  }
  return false;
}

// =================================================================== commands
export async function install(flags: Flags): Promise<number> {
  log.step(`${BRANDING.productName} install`);
  if (!flags.dryRun) assertSafeInstallerIdentity();
  const pf = preflight();
  const code = printChecks("Preflight", pf);
  if (code !== 0 && !flags.force) {
    log.err(
      "preflight failed — fix the above or re-run with --force. Aborting.",
    );
    return 1;
  }
  if (!flags.dryRun && !canSudoNonInteractive()) {
    log.warn("sudo will prompt for a password during install.");
  }

  const cfg = await gatherConfig(flags);
  log.step("Configuration");
  log.info(
    `mode=${cfg.mode}  domain=${cfg.domain}  port=${cfg.port}  user=${cfg.user}  data=${cfg.dataDir}`,
  );
  if (
    !flags.dryRun &&
    !flags.nonInteractive &&
    !(await confirm("Proceed with this configuration?"))
  )
    return 1;

  if (!flags.dryRun) {
    persistUserChannel(cfg, flags);
    const saved = saveConfig(cfg);
    log.ok(`wrote ${saved}`);
  } else {
    log.info("[dry-run] would write install.env");
  }

  log.step("TLS (certbot)");
  ensureTlsCertificate(cfg, flags);
  log.step("systemd units");
  applyUnits(cfg, flags);
  log.step("HTTPS-only nginx vhost + rate limits");
  applyNginx(cfg, flags);

  if (!flags.dryRun) {
    log.step("starting services");
    startServices(cfg);
    const ok = await healthcheck(cfg);
    if (!ok) {
      log.err(
        `service did not become healthy — see: journalctl -u ${webUnitName()} -n 50`,
      );
      return 1;
    }
    log.ok(
      `host-local health check passed; public origin is https://${cfg.domain}`,
    );
    if (getUserConfig({ dataDir: cfg.dataDir }).autoUpdate) configureAutoUpdate(cfg, true);
    log.step("first passkey");
    await enrollPasskey(cfg, flags);
  }

  log.step("done");
  log.ok(
    `${BRANDING.productName} installed. Open https://${cfg.domain} and register your passkey.`,
  );
  return 0;
}

export async function setup(flags: Flags): Promise<number> {
  log.step(`${BRANDING.productName} setup (reconfigure)`);
  if (!flags.dryRun) assertSafeInstallerIdentity();
  const cfg = await gatherConfig(flags, true);
  const artifactChanged = runnerArtifactChanged(cfg);
  log.step("TLS");
  ensureTlsCertificate(cfg, flags);
  if (!flags.dryRun) {
    persistUserChannel(cfg, flags);
    saveConfig(cfg);
    log.ok("updated install.env");
  }
  const { runnerChanged } = applyUnits(cfg, flags);
  applyNginx(cfg, flags);
  if (!flags.dryRun) {
    if (runnerChanged || artifactChanged) {
      log.warn(
        `runner ${runnerChanged ? "unit" : "artifact"} changed — restarting it (ends in-flight turns)`,
      );
      restartRunner(cfg);
    } else {
      log.ok("runner unchanged — leaving it up so in-flight turns survive");
    }
    restartWeb();
    const ok = await healthcheck(cfg);
    log[ok ? "ok" : "err"](ok ? "healthy" : "not healthy after restart");
    if (ok && getUserConfig({ dataDir: cfg.dataDir }).autoUpdate) configureAutoUpdate(cfg, true);
    return ok ? 0 : 1;
  }
  return 0;
}

// Internal sentinel set in the re-exec'd child's environment (below) so the
// freshly-installed CLI runs ONLY the render+restart phase instead of upgrading
// again. Not a user-facing flag.
const POST_UPGRADE_ENV = "PALMAGENT_UPDATE_POST_UPGRADE";

// Upgrade the globally-installed package on its current release channel. Try as the invoking user
// first (nvm/volta/fnm + user-writable prefixes); only on a permission error do
// we retry with sudo (a system-owned npm prefix). This tracks however the package
// was originally `npm i -g`'d — a plain install stays plain, a root install
// escalates — instead of unconditionally running sudo+nvm (a known footgun).
function installedVersion(pkgDir?: string): string {
  if (!pkgDir) throw new Error("installed package directory is missing");
  const version = String(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version);
  productVersion(version);
  return version;
}

function npmGlobalInstall(pkg: string, version: string, globalRoot: string): boolean {
  const spec = `${pkg}@${version}`;
  const first = run("npm", ["install", "-g", spec], { timeout: 600_000 });
  if (first.ok) return true;
  if (
    /EACCES|permission denied|EROFS/i.test(first.stderr) &&
    canSudoNonInteractive()
  ) {
    if (basename(globalRoot) !== "node_modules" || basename(dirname(globalRoot)) !== "lib") {
      throw new Error("cannot safely identify the existing npm prefix for a privileged retry");
    }
    log.info("retrying the global install with sudo …");
    return sudo(["npm", "install", "-g", "--prefix", dirname(dirname(globalRoot)), spec]).ok;
  }
  if (first.stderr.trim()) log.err(first.stderr.trim());
  return false;
}

export async function update(flags: Flags): Promise<number> {
  const cfg = loadInstalledConfig(flags);
  cfg.releaseChannel = flags.get("channel") !== undefined
    ? setUserChannel(flags.get("channel")!, { dryRun: true }).channel
    : getUserConfig({ dataDir: cfg.dataDir }).channel;
  const requestedVersion = flags.get("to");
  if (requestedVersion !== undefined) {
    if ((!flags.pull && !flags.plan) || cfg.mode !== "package") {
      throw new Error("--to requires update --pull on a package installation");
    }
    validateUpdateTarget(installedVersion(cfg.pkgDir), requestedVersion, cfg.releaseChannel);
  }
  if ((flags.pull || flags.plan) && cfg.mode === "source") {
    log.err("source checkouts are maintainer-managed and cannot self-update; use the repository build workflow and setup");
    return 1;
  }
  const pluginPaths = flags.getAll?.("plugin-manifest") ?? (flags.get("plugin-manifest") ? [flags.get("plugin-manifest")!] : []);
  const plugins = readPluginVersions(pluginPaths);
  if (flags.plan) {
    if (flags.dryRun || flags.automatic) throw new Error("--plan cannot be combined with --dry-run or --automatic");
    console.log(JSON.stringify(resolveUpdatePlan(installedVersion(cfg.pkgDir), cfg.releaseChannel, plugins, requestedVersion)));
    return 0;
  }
  if (flags.automatic && (!flags.pull || requestedVersion || flags.get("channel"))) throw new Error("--automatic requires --pull and follows only the saved channel");
  log.step(`${BRANDING.productName} update`);
  log.info(`Update channel: ${cfg.releaseChannel === "stable" ? "Stable" : "Preview"} (${channelTag(cfg.releaseChannel)})`);
  if (!flags.pull) return applyInstalledUpdate(cfg, flags);
  if (flags.automatic && !getUserConfig({ dataDir: cfg.dataDir }).autoUpdate) {
    log.info("automatic updates are off; nothing changed");
    return 0;
  }
  if (flags.dryRun) {
    log.info(`[dry-run] would resolve ${BRANDING.packageName}@${requestedVersion ?? channelTag(cfg.releaseChannel)}, verify plugin compatibility, install the exact target, and verify runtime health`);
    return 0;
  }

  const unlock = acquireUpdateLock(dirname(userConfigPath()));
  let endMaintenance: (() => void) | undefined;
  try {
    const previous = readUpdateReceipt(cfg.dataDir);
    if (flags.automatic && (previous?.status === "failed" || previous?.status === "applying")) {
      log.warn("automatic updates are paused after an unsuccessful attempt; use the update plugin to inspect and recover");
      return 0;
    }
    const plan = resolveUpdatePlan(installedVersion(cfg.pkgDir), cfg.releaseChannel, plugins, requestedVersion);
    const record = (status: "applying" | "succeeded" | "failed" | "deferred", reason: string) => writeUpdateReceipt(cfg.dataDir, {
      status, previousVersion: plan.currentVersion, targetVersion: plan.targetVersion, reason,
    });
    if (flags.automatic && !plan.automaticEligible) {
      record("deferred", "plugin-update-required");
      log.info("a plugin-assisted update is needed for the new compatibility line; automatic update deferred");
      return 0;
    }
    // Legacy plugins already checked their current CLI's compatibility. Keep
    // their existing --pull call working inside that line; a transition needs
    // explicit installed-manifest evidence from the coordinated update flow.
    if (!plugins.length && !plan.automaticEligible) throw new Error("crossing a compatibility line requires --plugin-manifest for each participating installed plugin; use update --plan first");
    if (plan.plugins.some((plugin) => plugin.action === "update")) throw new Error("the target needs a matching plugin; refresh it through its native manager, verify its installed manifest, and retry the same exact target");
    const recovering = previous?.status === "failed" || previous?.status === "applying";
    if (plan.packageAction === "keep" && !recovering) {
      if (!runtimeIsHealthy(cfg, plan.currentVersion)) throw new Error("the package is current but its running version is not healthy; use the doctor plugin before retrying");
      record("succeeded", "already-current");
      log.ok(`package ${plan.currentVersion} is already current and healthy; compatible plugins are retained`);
      return 0;
    }
    // Do not accidentally install to another npm prefix and only discover that
    // mismatch after replacing an unrelated global package.
    const root = run("npm", ["root", "-g"], { timeout: 10_000 });
    if (!root.ok || resolve(root.stdout.trim(), BRANDING.packageName) !== resolve(cfg.pkgDir!)) throw new Error("the active npm prefix does not own this installation; package files were not changed");
    if (flags.automatic) {
      if (!canSudoNonInteractive()) throw new Error("automatic updates require non-interactive service-management access");
      endMaintenance = beginUpdateMaintenance(cfg.dbPath);
      try {
        if (!await verifyUpdateIdle(cfg)) {
          record("deferred", "tasks-active");
          log.info("tasks are running, waiting, or queued; automatic update deferred");
          return 0;
        }
      } catch {
        record("deferred", "idle-state-unverified");
        log.warn("could not verify an idle maintenance window; automatic update deferred");
        return 0;
      }
      const latestSettings = getUserConfig({ dataDir: cfg.dataDir });
      if (!latestSettings.autoUpdate || latestSettings.channel !== plan.channel) {
        record("deferred", "settings-changed");
        return 0;
      }
    }
    // Preserve a legacy preference while its package metadata is still intact.
    initUserConfig({ dataDir: cfg.dataDir });
    record("applying", "package-install");
    try {
      log.info(`updating the package to ${plan.targetVersion}; compatible plugins are retained`);
      if (!npmGlobalInstall(BRANDING.packageName, plan.targetVersion, root.stdout.trim())) throw new Error("package installation failed");
      const cli = join(cfg.pkgDir!, "cli.js");
      const actual = run(process.execPath, [cli, "--version"]);
      if (!actual.ok || actual.stdout.trim() !== plan.targetVersion || installedVersion(cfg.pkgDir) !== plan.targetVersion) throw new Error("installed package identity does not match the planned target");
      const child = spawnSync(process.execPath, [cli, ...postUpgradeArgs(cfg, flags), "--expected-version", plan.targetVersion], {
        stdio: "inherit", env: { ...process.env, [POST_UPGRADE_ENV]: "1", ...(flags.automatic ? { PALMAGENT_NON_INTERACTIVE: "1" } : {}) },
      });
      if (child.status !== 0) throw new Error("service activation or target health verification failed");
      if (!runtimeIsHealthy(cfg, plan.targetVersion)) throw new Error("the running service does not match the healthy target version");
      const finalPlugins = readPluginVersions(pluginPaths);
      if (finalPlugins.some((plugin) => !compatiblePlugin(plan.targetVersion, plugin.version))) throw new Error("a plugin changed during the update and is no longer compatible");
      record("succeeded", "runtime-and-compatibility-verified");
      log.ok(`package ${plan.targetVersion} is healthy; ${plugins.length ? "participating plugin compatibility is verified" : "the plugin compatibility line is unchanged"}`);
      return 0;
    } catch (error) {
      record("failed", "manual-recovery-required");
      log.err(`${error instanceof Error ? error.message : "update failed"}; automatic retries are paused. Use the doctor/update plugin to recover; the previous package and database were not restored.`);
      return 1;
    }
  } finally {
    try { endMaintenance?.(); } finally { unlock(); }
  }
}

async function applyInstalledUpdate(cfg: InstallConfig, flags: Flags): Promise<number> {
  const expectedVersion = flags.get("expected-version");
  if (expectedVersion && (process.env[POST_UPGRADE_ENV] !== "1" || installedVersion(cfg.pkgDir) !== expectedVersion)) throw new Error("invalid update activation target");

  // Re-render units; restart the runner only when its unit or artifact changed
  // so a web-only update does not kill in-flight turns.
  ensureTlsCertificate(cfg, flags);
  const artifactChanged = runnerArtifactChanged(cfg);
  const { runnerChanged } = applyUnits(cfg, flags);
  applyNginx(cfg, flags);
  if (flags.dryRun) return 0;

  if (runnerChanged || artifactChanged) {
    log.warn(
      `runner ${runnerChanged ? "unit" : "artifact"} changed — restarting it (ends in-flight turns)`,
    );
    restartRunner(cfg);
  } else {
    log.ok("runner unchanged — leaving it up so in-flight turns survive");
  }
  restartWeb();
  const ok = await healthcheck(cfg, expectedVersion);
  if (ok) {
    persistUserChannel(cfg, flags);
    saveConfig(cfg);
  }
  log[ok ? "ok" : "err"](ok ? `updated + healthy` : "not healthy after update");
  return ok ? 0 : 1;
}

export async function uninstall(flags: Flags): Promise<number> {
  log.step(`${BRANDING.productName} uninstall`);
  const cfg = loadInstalledConfig(flags);
  if (flags.purge) {
    assertSafePurgeTarget(cfg.dataDir);
    assertUserConfigPreserved(cfg.dataDir);
  }
  const units = renderUnits(cfg);
  if (flags.dryRun) {
    log.info(
      `[dry-run] would stop+disable ${units.web.name} and ${units.runner.name}, remove their unit files and the nginx vhost`,
    );
    if (flags.purge)
      log.info(`[dry-run] --purge would DELETE the data dir ${cfg.dataDir}`);
    return 0;
  }
  if (
    !flags.nonInteractive &&
    !(await confirm(
      `Remove ${BRANDING.productName} services on this host?`,
      false,
    ))
  )
    return 1;

  // Preserve a legacy channel before service data can be removed.
  initUserConfig({ dataDir: cfg.dataDir });
  removeAutoUpdateTimer();
  for (const name of [units.web.name, units.runner.name]) {
    sudo(["systemctl", "disable", "--now", name]);
    sudo(["rm", "-f", join(SYSTEMD_DIR, name)]);
  }
  sudo(["systemctl", "daemon-reload"]);
  const ng = renderNginx(cfg);
  sudo([
    "rm",
    "-f",
    join(NGINX_SITES_ENABLED, ng.vhost.name),
    join(NGINX_SITES_AVAIL, ng.vhost.name),
    join(NGINX_CONFD, ng.vhost.name),
    join(NGINX_CONFD, ng.zones.name),
  ]);
  if (which("nginx")) sudo(["systemctl", "reload", "nginx"]);
  log.ok("services + nginx vhost removed");

  if (flags.purge) {
    const approved =
      flags.nonInteractive ||
      (await confirm(
        `DELETE all data at ${cfg.dataDir} (DB, push subscribers, VAPID keys — irreversible)?`,
        false,
      ));
    if (approved) {
      const removed = sudo(["rm", "-rf", cfg.dataDir]);
      if (!removed.ok)
        throw new Error(`failed to purge ${cfg.dataDir}:\n${removed.stderr}`);
      log.ok(`purged ${cfg.dataDir}`);
    } else {
      log.info(`data preserved at ${cfg.dataDir}`);
    }
  } else {
    log.info(`data preserved at ${cfg.dataDir} (use --purge to delete)`);
  }
  return 0;
}

/** `passkey` — mint a fresh enroll link against an existing install. */
export async function passkey(flags: Flags): Promise<number> {
  const cfg = loadInstalledConfig(flags);
  await enrollPasskey(cfg, { dryRun: false } as Flags);
  return 0;
}

export function runDoctor(flags: Flags): number {
  const cfg = loadInstalledConfig(flags);
  let updateFailure = false;
  try {
    const receipt = readUpdateReceipt(cfg.dataDir);
    if (receipt) log.info(`Last update: ${receipt.status} (${receipt.previousVersion} → ${receipt.targetVersion}; ${receipt.reason})`);
    updateFailure = receipt?.status === "failed" || receipt?.status === "applying";
    if (updateFailure) log.warn("automatic retries are paused; inspect package/runtime identity and recover through the update plugin");
  } catch {
    updateFailure = true;
    log.warn("the last update result is unreadable; inspect it before retrying");
  }
  try {
    const channel = getUserConfig({ dataDir: cfg.dataDir }).channel;
    log.info(`Update channel: ${channel === "stable" ? "Stable" : "Preview"} (${channelTag(channel)})`);
  } catch {
    log.warn("Update channel is unknown: user or legacy settings could not be read");
  }
  const code = printChecks(
    `${BRANDING.productName} doctor — ${cfg.domain}`,
    doctor(cfg),
  );
  return code || (updateFailure ? 1 : 0);
}
