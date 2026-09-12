// The operator-facing orchestration CLI — the deterministic "brain" the Claude
// Code + Codex plugins (and a plain shell) all drive. It is the ONLY place that
// touches systemd / nginx / certbot / passkeys / the install config.
//
// Bundled to `<pkg>/cli.js` (esbuild, scripts/build-pkg.ts) and exposed as the
// package `bin`. server.js, runner-daemon.js, and web/ sit beside it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { BRANDING } from "@palmagent/shared";
import { ensurePrivateDirectory } from "../private-files.js";
import { getUserConfig, initUserConfig, setUserChannel } from "./user-config.js";
import { compatiblePlugin } from "./release-policy.js";
import { resolveDataDir } from "./config.js";
import { userConfigPath } from "./user-config.js";
import { acquireUpdateLock } from "./update-state.js";
import { autoUpdateStatus, configureAutoUpdate } from "./auto-update.js";
import {
  install,
  loadInstalledConfig,
  type Flags,
  passkey,
  runDoctor,
  setup,
  uninstall,
  update,
} from "./install.js";

const PKG_DIR = dirname(fileURLToPath(import.meta.url));

function version(): string {
  try {
    return String(
      JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")).version ??
        "0.0.0",
    );
  } catch {
    return "0.0.0";
  }
}

// Boot the bundled web server (dev/manual use; production runs `node server.js`
// directly via the systemd unit). Fills package-relative env defaults.
async function start(flags: Flags): Promise<void> {
  const dataDir = resolveDataDir(flags.get("data-dir"));
  ensurePrivateDirectory(dataDir);
  process.env.DISPATCHER_DATA_DIR = dataDir;
  if (!process.env.STATIC_DIR) {
    const web = join(PKG_DIR, "web");
    if (existsSync(join(web, "index.html"))) process.env.STATIC_DIR = web;
  }
  await import(join(PKG_DIR, "server.js"));
}

// Parse `--flag`, `--flag=value`, and `--flag value` after the subcommand.
function parseFlags(argv: string[]): Flags {
  const bools = new Set([
    "dry-run",
    "non-interactive",
    "force",
    "purge",
    "pull",
    "plan",
    "automatic",
  ]);
  const vals: Record<string, string> = {};
  const multiple: Record<string, string[]> = {};
  const set = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-y") {
      set.add("non-interactive");
      continue;
    }
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq >= 0) {
      vals[a.slice(2, eq)] = a.slice(eq + 1);
      (multiple[a.slice(2, eq)] ??= []).push(a.slice(eq + 1));
      continue;
    }
    const key = a.slice(2);
    if (["channel", "to", "plugin-version", "plugin-manifest", "expected-version"].includes(key) &&
        (i + 1 === argv.length || argv[i + 1].startsWith("-"))) {
      throw new Error(`--${key} requires a value`);
    }
    if (bools.has(key)) set.add(key);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      vals[key] = argv[++i];
      (multiple[key] ??= []).push(vals[key]);
    }
    else set.add(key);
  }
  return {
    dryRun: set.has("dry-run"),
    nonInteractive: set.has("non-interactive"),
    force: set.has("force"),
    purge: set.has("purge"),
    pull: set.has("pull"),
    plan: set.has("plan"),
    automatic: set.has("automatic"),
    get: (k) => vals[k],
    getAll: (k) => multiple[k] ?? [],
  };
}

function printHelp(): void {
  console.log(`${BRANDING.productName} — ${BRANDING.cliName} v${version()}

Usage: ${BRANDING.cliName} <command> [options]

Commands:
  install      First-run setup: systemd units, nginx, TLS (certbot), first passkey
  setup        Reconfigure an existing install + re-render units/nginx
  doctor       Diagnose a running instance + suggest fixes
  update       Apply config, or fetch the selected release channel with --pull
  auto-update  Internal scheduler API: enable, disable, status (off by default)
  config       Internal plugin settings API: get, init, set --channel <name>
  compatibility  Check the installed CLI against an operator plugin version
  uninstall    Remove the units + nginx vhost (data preserved unless --purge)
  passkey      Mint a fresh device-enroll link for an existing install
  start        Run the web server directly (dev/manual; reads env)

Common options:
  --dry-run            Render + print everything, change nothing (install/setup/update/uninstall)
  --non-interactive,-y Never prompt; use flags/defaults
  --domain <d>         Public domain (required for a fresh install)
  --port <n>           Internal loopback port (default 4100)
  --concurrency <n>    Max concurrent turns (default 8)
  --data-dir <path>    Locate install state for every command (default ~/.local/state/${BRANDING.stateDirName})
  --repo-roots <list>  Colon-separated repo scan roots
  --claude-config-dir <path>  Claude CLI config/creds dir (CLAUDE_CONFIG_DIR); blank = ~/.claude
  --force              Proceed past failed preflight (install)
  --pull               update: fetch the selected npm release channel (package installs only)
  --plan               update: resolve the exact target and plugin actions as JSON; change nothing
  --plugin-manifest <p> update: installed plugin.json path; repeat for each participating plugin
  --automatic          update --pull: saved opt-in, same compatibility line, idle tasks only
  --channel <name>     stable (default for new installs) or preview; remembered for updates
  --to <version>       update --pull: select an exact version; downgrades are rejected
  --plugin-version <v> compatibility: require the same x.x.x, including prereleases
  --purge              uninstall: also delete the data dir (irreversible)

  --version            Print the version
  --help               Print this help
`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (rest.includes("--help") || rest.includes("-h")) {
    printHelp();
    return;
  }
  const flags = parseFlags(rest);
  if (flags.nonInteractive || flags.automatic) process.env.PALMAGENT_NON_INTERACTIVE = "1";
  for (const [flag, commands] of Object.entries({
    channel: ["config", "install", "setup", "update"],
    to: ["update"],
    "plugin-version": ["compatibility"],
    "plugin-manifest": ["update"],
    "expected-version": ["update"],
  })) {
    if (flags.get(flag) !== undefined && !commands.includes(cmd)) {
      throw new Error(`--${flag} is only supported by ${commands.join("/")}`);
    }
  }
  if ((flags.plan || flags.automatic) && cmd !== "update") throw new Error("--plan and --automatic are update options");
  switch (cmd) {
    case "auto-update": {
      const action = rest[0];
      if (!["enable", "disable", "status"].includes(action)) throw new Error("usage: auto-update enable|disable|status [--data-dir <path>] [--dry-run]");
      parseArgs({ args: rest.slice(1), strict: true, allowPositionals: false, options: {
        "data-dir": { type: "string" }, "dry-run": { type: "boolean" }, "non-interactive": { type: "boolean", short: "y" },
      } });
      const cfg = loadInstalledConfig(flags);
      if (action !== "status") await withHostLock(flags, async () => configureAutoUpdate(cfg, action === "enable", flags.dryRun));
      if (!flags.dryRun) console.log(JSON.stringify(autoUpdateStatus(cfg)));
      return;
    }
    case "config": {
      const action = rest[0];
      if (!["get", "init", "set"].includes(action)) {
        throw new Error("usage: config get|init|set [--channel stable|preview] [--data-dir <path>] [--dry-run]");
      }
      parseArgs({ args: rest.slice(1), strict: true, allowPositionals: false, options: {
        channel: { type: "string" }, "data-dir": { type: "string" }, "dry-run": { type: "boolean" },
      } });
      if (action !== "set" && flags.get("channel") !== undefined) {
        throw new Error("--channel requires config set");
      }
      const options = { dataDir: flags.get("data-dir"), dryRun: flags.dryRun };
      const config = action === "get" ? getUserConfig(options)
        : action === "init" ? initUserConfig(options)
        : setUserChannel(flags.get("channel") ?? "", options);
      console.log(JSON.stringify(config));
      return;
    }
    case "compatibility": {
      const pluginVersion = flags.get("plugin-version");
      if (!pluginVersion) throw new Error("compatibility requires --plugin-version <version>");
      const ok = compatiblePlugin(version(), pluginVersion);
      console.log(`CLI ${version()} / plugin ${pluginVersion}: ${ok ? "compatible" : "incompatible (different x.x.x); install a matching plugin release"}`);
      process.exit(ok ? 0 : 1);
    }
    case "start":
      return start(flags);
    case "install":
      process.exit(await withHostLock(flags, () => install(flags)));
    case "setup":
      process.exit(await withHostLock(flags, () => setup(flags)));
    case "doctor":
      process.exit(runDoctor(flags));
    case "update":
      parseArgs({ args: rest, strict: true, allowPositionals: false, options: {
        "dry-run": { type: "boolean" }, "non-interactive": { type: "boolean", short: "y" },
        pull: { type: "boolean" }, plan: { type: "boolean" }, automatic: { type: "boolean" },
        "data-dir": { type: "string" }, channel: { type: "string" }, to: { type: "string" },
        "plugin-manifest": { type: "string", multiple: true }, "expected-version": { type: "string" },
      } });
      process.exit(flags.pull || flags.plan || process.env.PALMAGENT_UPDATE_POST_UPGRADE === "1"
        ? await update(flags) : await withHostLock(flags, () => update(flags)));
    case "uninstall":
      process.exit(await withHostLock(flags, () => uninstall(flags)));
    case "passkey":
      process.exit(await passkey(flags));
    case "--version":
    case "-v":
      console.log(version());
      return;
    case undefined:
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      console.error(`unknown command: ${cmd}\n`);
      printHelp();
      process.exit(2);
  }
}

async function withHostLock<T>(flags: Flags, operation: () => Promise<T>): Promise<T> {
  if (flags.dryRun) return operation();
  const unlock = acquireUpdateLock(dirname(userConfigPath()));
  try { return await operation(); } finally { unlock(); }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
