// install / setup / update / uninstall orchestration. This is the only code
// that mutates the host (systemd units, nginx, certbot, the SQLite db). Every
// mutating step is gated behind --dry-run (render + print, touch nothing) so the
// flow is inspectable and CI-testable; real mutations need sudo.
//
// These commands are the packaged install/update path. Source mode supports a
// checked-out maintainer build, but public self-update is package-only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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
  get(key: string): string | undefined;
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
    ...(flags.nonInteractive ? ["-y"] : []),
  ];
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

  const cfg: InstallConfig = {
    ...base,
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

async function healthcheck(cfg: InstallConfig): Promise<boolean> {
  // Host-local transport stays on loopback. Every browser-facing origin is
  // HTTPS-only through the generated nginx vhost.
  const url = `http://${cfg.host}:${cfg.port}/api/health`;
  for (let i = 0; i < 30; i++) {
    const r = run("curl", ["-fsS", url]);
    if (r.ok) return true;
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
function installedReleaseTag(pkgDir?: string): "next" | "latest" {
  if (!pkgDir) return "latest";
  try {
    const version = String(
      JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version ??
        "",
    );
    return version.includes("-") ? "next" : "latest";
  } catch {
    return "latest";
  }
}

function npmGlobalInstall(pkg: string, tag: "next" | "latest"): boolean {
  const spec = `${pkg}@${tag}`;
  const first = run("npm", ["install", "-g", spec]);
  if (first.ok) return true;
  if (
    /EACCES|permission denied|EROFS/i.test(first.stderr) &&
    canSudoNonInteractive()
  ) {
    log.info("retrying the global install with sudo …");
    return sudo(["npm", "install", "-g", spec]).ok;
  }
  if (first.stderr.trim()) log.err(first.stderr.trim());
  return false;
}

export async function update(flags: Flags): Promise<number> {
  log.step(`${BRANDING.productName} update`);
  const cfg = loadInstalledConfig(flags);

  // `--pull` fetches the current npm dist-tag for package installs. Source
  // checkouts are maintainer-managed and never mutate Git from this host CLI.
  // A bare `update` only re-renders units + restarts.
  if (flags.pull && cfg.mode === "source") {
    log.err(
      "source checkouts are maintainer-managed and cannot self-update; use the repository pnpm verification/build workflow, then run palmagent setup",
    );
    return 1;
  } else if (
    flags.pull &&
    cfg.mode === "package" &&
    process.env[POST_UPGRADE_ENV] !== "1"
  ) {
    const releaseTag = installedReleaseTag(cfg.pkgDir);
    // Package install: pull the new bundle from npm, then hand off to the
    // freshly-installed CLI so the units render from ITS (possibly newer)
    // templates — this process is still the OLD cli.js bundle (cf. the deploy
    // self-modify gotcha). The sentinel env stops the child re-upgrading.
    if (flags.dryRun) {
      log.info(
        `[dry-run] would run: npm install -g ${BRANDING.packageName}@${releaseTag}, then re-render units + restart`,
      );
    } else {
      log.info(
        `upgrading ${BRANDING.packageName} via npm (i -g ${BRANDING.packageName}@${releaseTag}) …`,
      );
      if (!npmGlobalInstall(BRANDING.packageName, releaseTag)) {
        log.err(
          `npm upgrade failed — install it yourself (\`npm i -g ${BRANDING.packageName}@${releaseTag}\`, add sudo if your npm prefix needs it) then re-run \`${BRANDING.cliName} update\`.`,
        );
        return 1;
      }
      log.ok(`upgraded ${BRANDING.packageName}`);
      const bin = which(BRANDING.cliName);
      if (bin) {
        log.info("applying units + restarting with the upgraded CLI …");
        const child = spawnSync(
          bin,
          postUpgradeArgs(cfg, flags),
          {
            stdio: "inherit",
            env: { ...process.env, [POST_UPGRADE_ENV]: "1" },
          },
        );
        return child.status ?? 1;
      }
      log.warn(
        `could not locate the upgraded ${BRANDING.cliName} on PATH — applying units with the current CLI; re-run \`${BRANDING.cliName} setup --data-dir ${cfg.dataDir}\` if this release changed the unit templates.`,
      );
    }
  }

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
  const ok = await healthcheck(cfg);
  log[ok ? "ok" : "err"](ok ? `updated + healthy` : "not healthy after update");
  return ok ? 0 : 1;
}

export async function uninstall(flags: Flags): Promise<number> {
  log.step(`${BRANDING.productName} uninstall`);
  const cfg = loadInstalledConfig(flags);
  if (flags.purge) assertSafePurgeTarget(cfg.dataDir);
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
  return printChecks(
    `${BRANDING.productName} doctor — ${cfg.domain}`,
    doctor(cfg),
  );
}
