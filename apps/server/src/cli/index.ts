// The operator-facing orchestration CLI — the deterministic "brain" the Claude
// Code + Codex plugins (and a plain shell) all drive. It is the ONLY place that
// touches systemd / nginx / certbot / passkeys / the install config.
//
// Bundled to `<pkg>/cli.js` (esbuild, scripts/build-pkg.ts) and exposed as the
// package `bin`. server.js, runner-daemon.js, and web/ sit beside it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRANDING } from "@palmagent/shared";
import { ensurePrivateDirectory } from "../private-files.js";
import { resolveDataDir } from "./config.js";
import {
  install,
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
  ]);
  const vals: Record<string, string> = {};
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
      continue;
    }
    const key = a.slice(2);
    if (bools.has(key)) set.add(key);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--"))
      vals[key] = argv[++i];
    else set.add(key);
  }
  return {
    dryRun: set.has("dry-run"),
    nonInteractive: set.has("non-interactive"),
    force: set.has("force"),
    purge: set.has("purge"),
    pull: set.has("pull"),
    get: (k) => vals[k],
  };
}

function printHelp(): void {
  console.log(`${BRANDING.productName} — ${BRANDING.cliName} v${version()}

Usage: ${BRANDING.cliName} <command> [options]

Commands:
  install      First-run setup: systemd units, nginx, TLS (certbot), first passkey
  setup        Reconfigure an existing install + re-render units/nginx
  doctor       Diagnose a running instance + suggest fixes
  update       Apply config, or fetch the installed npm channel with --pull (package installs only)
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
  --pull               update: fetch the installed npm release channel (source checkouts are maintainer-managed)
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
  switch (cmd) {
    case "start":
      return start(flags);
    case "install":
      process.exit(await install(flags));
    case "setup":
      process.exit(await setup(flags));
    case "doctor":
      process.exit(runDoctor(flags));
    case "update":
      process.exit(await update(flags));
    case "uninstall":
      process.exit(await uninstall(flags));
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

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
