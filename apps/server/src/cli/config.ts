// Install configuration: resolve every host value the systemd units + nginx
// vhost need, from `<data-dir>/install.env` (written by `install`). Persisted as
// a simple KEY=VALUE env file the units/CLI both read, and parsed/validated with
// a zod schema.
//
// NO personal/host fallbacks: identity (the public domain) has NO default, and
// ops commands (doctor/update/setup/uninstall) fail-fast when install.env is
// missing — they never assume a host's identity. Only universally-safe
// operational values (port, concurrency, data dir) carry defaults; repo-scan
// roots are prompted at setup, not defaulted; the DoS caps default to the
// reference values but are adjustable via the CAP_* keys.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BRANDING, type UpdateChannel } from "@palmagent/shared";
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
} from "../private-files.js";

/** How the services are launched. */
export type RunMode = "package" | "source";

export interface InstallConfig {
  mode: RunMode;
  /** Effective channel for this operation; persisted only in the user config. */
  releaseChannel?: UpdateChannel;
  user: string;
  group: string;
  /** Persistent data (SQLite + VAPID keys + install.env). */
  dataDir: string;
  /** web ↔ runner Unix socket. */
  runnerSocket: string;
  dbPath: string;
  /** package mode: directory holding the bundled server.js/runner-daemon.js/cli.js. */
  pkgDir?: string;
  /** source mode: the git checkout root. */
  repoDir?: string;
  /** systemd WorkingDirectory. */
  workingDir: string;
  /** PATH baked into the units (must resolve node + claude + codex). */
  execPath: string;
  domain: string;
  host: string;
  port: number;
  concurrency: number;
  rpId: string;
  rpName: string;
  authOrigin: string;
  /** Web Push (VAPID) contact (mailto:/https). Empty ⇒ push disabled (no default). */
  pushSubject: string;
  /** REPO_ROOTS (colon-separated) for the repo picker; empty ⇒ discovery off. */
  repoRoots: string;
  /** Claude CLI's own config/credentials dir (its CLAUDE_CONFIG_DIR). Empty ⇒ the CLI's own default (~/.claude). */
  claudeConfigDir: string;
  caps: ResourceCaps;
}

export interface ResourceCaps {
  memHigh: string;
  memMax: string;
  tasksMaxRunner: number;
  cpuQuota: string;
  nofile: number;
  tasksMaxWeb: number;
}

// Conservative resource-cap defaults. Operators can adjust them per host with
// CAP_* values in install.env and re-run setup.
export const DEFAULT_CAPS: ResourceCaps = {
  memHigh: "12G",
  memMax: "16G",
  tasksMaxRunner: 2048,
  cpuQuota: "300%",
  nofile: 65536,
  tasksMaxWeb: 512,
};

// Universally-safe operational defaults — NOT identity/host-specific. The public
// domain and run-as user have no literal default (detected or required).
const LOOPBACK_IPV4 = ["127", "0", "0", "1"].join(".");

const DEFAULTS = {
  host: LOOPBACK_IPV4,
  port: 4100,
  concurrency: 8,
};

const PublicDomain = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/,
    "DOMAIN must be a public hostname without a scheme, path, or port",
  )
  .transform((value) => value.toLowerCase());

const isLoopbackHost = (value: string): boolean =>
  value === "localhost" ||
  value === "::1" ||
  /^127(?:\.\d{1,3}){3}$/.test(value);

const LoopbackHost = z
  .string()
  .min(1)
  .refine(
    isLoopbackHost,
    "HOST must be loopback; terminate public HTTPS at nginx",
  );
const Port = z.coerce.number().int().min(1).max(65_535);
const Concurrency = z.coerce.number().int().min(1);
const PushSubject = z
  .string()
  .regex(
    /^(?:mailto:[^@\s]+@[^@\s]+\.[^@\s]+|https:\/\/\S+)$/,
    "PUSH_SUBJECT must be a mailto: address or an https:// URL",
  );

// install.env schema (zod). Validates/coerces the file's values and applies the
// safe operational + caps defaults. Identity (DOMAIN) and detected fields stay
// optional here; the required-ness is enforced in loadConfig/gatherConfig.
const InstallEnv = z
  .object({
    MODE: z.enum(["package", "source"]).optional(),
    RUN_USER: z.string().min(1).optional(),
    RUN_GROUP: z.string().min(1).optional(),
    DOMAIN: PublicDomain.optional(),
    HOST: LoopbackHost.default(DEFAULTS.host),
    PORT: Port.default(DEFAULTS.port),
    DISPATCH_CONCURRENCY: Concurrency.default(DEFAULTS.concurrency),
    DATA_DIR: z.string().min(1).optional(),
    RUNNER_SOCKET: z.string().min(1).optional(),
    DISPATCHER_DB: z.string().min(1).optional(),
    WORKING_DIR: z.string().min(1).optional(),
    EXEC_PATH: z.string().min(1).optional(),
    PKG_DIR: z.string().min(1).optional(),
    REPO_DIR: z.string().min(1).optional(),
    REPO_ROOTS: z.string().optional(),
    CLAUDE_CONFIG_DIR: z.string().min(1).optional(),
    PUSH_SUBJECT: PushSubject.optional(),
    CAP_MEM_HIGH: z.string().min(1).default(DEFAULT_CAPS.memHigh),
    CAP_MEM_MAX: z.string().min(1).default(DEFAULT_CAPS.memMax),
    CAP_TASKS_MAX_RUNNER: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_CAPS.tasksMaxRunner),
    CAP_CPU_QUOTA: z.string().min(1).default(DEFAULT_CAPS.cpuQuota),
    CAP_NOFILE: z.coerce.number().int().positive().default(DEFAULT_CAPS.nofile),
    CAP_TASKS_MAX_WEB: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_CAPS.tasksMaxWeb),
  })
  .passthrough();

export function validateInstallInput(values: {
  domain: string;
  host: string;
  port: number;
  concurrency: number;
  pushSubject: string;
}): {
  domain: string;
  host: string;
  port: number;
  concurrency: number;
  pushSubject: string;
} {
  return z
    .object({
      domain: PublicDomain,
      host: LoopbackHost,
      port: Port,
      concurrency: Concurrency,
      pushSubject: z.union([z.literal(""), PushSubject]),
    })
    .parse(values);
}

/** Detect a PATH for package-mode installs: prepend the dirs of the tools we found. */
export function detectExecPath(): string {
  const parts = new Set<string>();
  for (const tool of ["node", "claude", "codex"]) {
    try {
      const p = execFileSync("bash", ["-lc", `command -v ${tool}`], {
        encoding: "utf8",
      }).trim();
      if (p) parts.add(dirname(p));
    } catch {
      /* not found — preflight will flag it */
    }
  }
  for (const d of (process.env.PATH ?? "").split(":")) if (d) parts.add(d);
  return [...parts].join(":");
}

/** Auth RP identity derived from the public domain. */
export function authFromDomain(
  domain: string,
): Pick<InstallConfig, "rpId" | "rpName" | "authOrigin"> {
  return {
    rpId: domain,
    rpName: BRANDING.productName,
    authOrigin: domain ? `https://${domain}` : "",
  };
}

export function installEnvPath(dataDir: string): string {
  return join(dataDir, "install.env");
}

export function resolveDataDir(requested?: string): string {
  const value =
    requested ??
    process.env.DISPATCHER_DATA_DIR ??
    join(homedir(), ".local", "state", BRANDING.stateDirName);
  const expanded =
    value === "~"
      ? homedir()
      : value.startsWith("~/")
        ? join(homedir(), value.slice(2))
        : value;
  return resolve(expanded);
}

/** The installer elevates individual host mutations; running the whole CLI as
 * root would make the agent services and their child processes root-owned. */
export function assertSafeInstallerIdentity(
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
): void {
  if (uid === 0) {
    throw new Error(
      `do not run ${BRANDING.cliName} install/setup with sudo or as root; run it as the account that should own the agent processes (the CLI invokes sudo only for system files)`,
    );
  }
}

export function assertSafePurgeTarget(
  requested: string,
  home = homedir(),
): void {
  const target = resolve(requested);
  const broadTargets = new Set([
    resolve("/"),
    resolve("/home"),
    resolve("/opt"),
    resolve("/srv"),
    resolve("/tmp"),
    resolve("/var"),
    resolve("/var/lib"),
    resolve(home),
    resolve(home, ".local"),
    resolve(home, ".local", "state"),
  ]);
  if (broadTargets.has(target)) {
    throw new Error(
      `refusing to purge broad data directory ${target}; choose the dedicated Palmagent state directory explicitly`,
    );
  }
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const val = line.slice(eq + 1).trim();
    if (val !== "") out[line.slice(0, eq).trim()] = val; // empty ⇒ unset (let zod default/optional apply)
  }
  return out;
}

/**
 * Resolve the install config from `<dataDir>/install.env`, validated with zod.
 * Identity (DOMAIN, run-as user) has NO personal default; only operational values
 * fall back to universally-safe defaults. When `requireInstalled` is set (ops
 * commands), a missing install.env — or one missing DOMAIN — is a hard error; we
 * never assume a host's identity. `opts.pkgDir` marks a package-mode caller.
 */
export function loadConfig(
  opts: { dataDir?: string; pkgDir?: string; requireInstalled?: boolean } = {},
): InstallConfig {
  const dataDir = resolveDataDir(opts.dataDir);
  const envFile = installEnvPath(dataDir);
  const exists = existsSync(envFile);
  if (opts.requireInstalled && !exists) {
    throw new Error(
      `no install config at ${envFile} — run \`${BRANDING.cliName} install\` first.`,
    );
  }
  const e = InstallEnv.parse(
    exists ? parseEnvFile(readFileSync(envFile, "utf8")) : {},
  );

  const domain = e.DOMAIN ?? "";
  if (opts.requireInstalled && !domain) {
    throw new Error(
      `install config at ${envFile} is missing DOMAIN — re-run \`${BRANDING.cliName} setup\`.`,
    );
  }

  const mode: RunMode = e.MODE ?? (opts.pkgDir ? "package" : "source");
  const user = e.RUN_USER ?? safeUser() ?? "";
  const repoDir = e.REPO_DIR;
  const pkgDir = opts.pkgDir ?? e.PKG_DIR;
  const workingDir =
    e.WORKING_DIR ??
    (mode === "source"
      ? repoDir
        ? join(repoDir, "apps", "server")
        : dataDir
      : (pkgDir ?? dataDir));

  const palmagentDbPath = join(dataDir, "palmagent.db");
  const legacyDbPath = join(dataDir, "dispatcher.db");
  const dbPath =
    e.DISPATCHER_DB ??
    (existsSync(palmagentDbPath) || !existsSync(legacyDbPath)
      ? palmagentDbPath
      : legacyDbPath);

  return {
    mode,
    user,
    group: e.RUN_GROUP ?? safeGroup(user) ?? user,
    dataDir,
    runnerSocket: e.RUNNER_SOCKET ?? join(dataDir, "runner.sock"),
    dbPath,
    pkgDir,
    repoDir,
    workingDir,
    execPath: e.EXEC_PATH ?? detectExecPath(),
    domain,
    host: e.HOST,
    port: e.PORT,
    concurrency: e.DISPATCH_CONCURRENCY,
    pushSubject: e.PUSH_SUBJECT ?? "",
    repoRoots: e.REPO_ROOTS ?? "",
    claudeConfigDir: e.CLAUDE_CONFIG_DIR ?? "",
    ...authFromDomain(domain),
    caps: {
      memHigh: e.CAP_MEM_HIGH,
      memMax: e.CAP_MEM_MAX,
      tasksMaxRunner: e.CAP_TASKS_MAX_RUNNER,
      cpuQuota: e.CAP_CPU_QUOTA,
      nofile: e.CAP_NOFILE,
      tasksMaxWeb: e.CAP_TASKS_MAX_WEB,
    },
  };
}

export function saveConfig(cfg: InstallConfig): string {
  ensurePrivateDirectory(cfg.dataDir);
  const lines = [
    `# ${BRANDING.productName} install config — written by \`${BRANDING.cliName} install/setup\`.`,
    `# Edit then re-run \`${BRANDING.cliName} setup\` to re-render the units + nginx vhost.`,
    `MODE=${cfg.mode}`,
    `RUN_USER=${cfg.user}`,
    `RUN_GROUP=${cfg.group}`,
    `DOMAIN=${cfg.domain}`,
    `HOST=${cfg.host}`,
    `PORT=${cfg.port}`,
    `DISPATCH_CONCURRENCY=${cfg.concurrency}`,
    `DATA_DIR=${cfg.dataDir}`,
    `RUNNER_SOCKET=${cfg.runnerSocket}`,
    `DISPATCHER_DB=${cfg.dbPath}`,
    `WORKING_DIR=${cfg.workingDir}`,
    `EXEC_PATH=${cfg.execPath}`,
    cfg.pkgDir ? `PKG_DIR=${cfg.pkgDir}` : "",
    cfg.repoDir ? `REPO_DIR=${cfg.repoDir}` : "",
    cfg.repoRoots ? `REPO_ROOTS=${cfg.repoRoots}` : "",
    cfg.claudeConfigDir ? `CLAUDE_CONFIG_DIR=${cfg.claudeConfigDir}` : "",
    cfg.pushSubject ? `PUSH_SUBJECT=${cfg.pushSubject}` : "",
    "# DoS blast-radius caps (adjust per host, then re-run setup):",
    `CAP_MEM_HIGH=${cfg.caps.memHigh}`,
    `CAP_MEM_MAX=${cfg.caps.memMax}`,
    `CAP_TASKS_MAX_RUNNER=${cfg.caps.tasksMaxRunner}`,
    `CAP_CPU_QUOTA=${cfg.caps.cpuQuota}`,
    `CAP_NOFILE=${cfg.caps.nofile}`,
    `CAP_TASKS_MAX_WEB=${cfg.caps.tasksMaxWeb}`,
    "",
  ].filter((l) => l !== "");
  const file = installEnvPath(cfg.dataDir);
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  ensurePrivateFile(file);
  return file;
}

function safeUser(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

function safeGroup(user: string): string | undefined {
  if (!user) return undefined;
  try {
    const group = execFileSync("id", ["-gn", user], {
      encoding: "utf8",
    }).trim();
    return group || undefined;
  } catch {
    return undefined;
  }
}

/** Where the running CLI bundle lives (package mode autodetect). */
export function callerPkgDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}
