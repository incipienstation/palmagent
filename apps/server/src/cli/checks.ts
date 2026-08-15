// Preflight (before install) + doctor (diagnose a running instance) checks.
// Each returns structured results; the CLI prints them and the plugin layer can
// reason over a fault. Real systemd/nginx/certbot calls are best-effort and
// degrade gracefully when a tool is absent.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { BRANDING } from "@palmagent/shared";
import type { InstallConfig } from "./config.js";
import { runnerUnitName, webUnitName } from "./units.js";
import { log, run, sudo, which } from "./sh.js";

export type Level = "ok" | "warn" | "fail";
export interface Check {
  name: string;
  level: Level;
  detail: string;
  fix?: string;
}

function unitActive(name: string): boolean {
  return run("systemctl", ["is-active", "--quiet", name]).ok;
}

/** Ask each CLI to validate its own stored authentication state. This is more
 * meaningful than checking whether a credential file or directory merely
 * exists, and it never prints the CLI's potentially sensitive output. */
function authStatus(
  tool: "claude" | "codex",
  claudeConfigDir?: string,
): boolean {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  if (tool === "claude" && claudeConfigDir)
    env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  const args = tool === "claude" ? ["auth", "status"] : ["login", "status"];
  return run(tool, args, { env, timeout: 10_000 }).ok;
}

function checkAgents(claudeConfigDir?: string): Check[] {
  const checks: Check[] = [];
  let authenticated = 0;
  for (const tool of ["claude", "codex"] as const) {
    const path = which(tool);
    if (!path) {
      checks.push({
        name: tool,
        level: "warn",
        detail: "not installed",
        fix: `install and sign in to the ${tool} CLI to enable this provider`,
      });
      continue;
    }
    checks.push({ name: tool, level: "ok", detail: path });
    const ok = authStatus(
      tool,
      tool === "claude" ? claudeConfigDir : undefined,
    );
    if (ok) authenticated++;
    checks.push(
      ok
        ? {
            name: `${tool} auth`,
            level: "ok",
            detail: "CLI reports authenticated",
          }
        : {
            name: `${tool} auth`,
            level: "warn",
            detail: "CLI authentication status failed",
            fix: `run \`${tool}\` interactively and sign in again`,
          },
    );
  }
  if (authenticated === 0) {
    checks.push({
      name: "agent provider",
      level: "fail",
      detail: "no authenticated CLI is available",
      fix: "sign in to at least one installed provider CLI",
    });
  }
  return checks;
}

// ----------------------------------------------------------------- preflight
export function preflight(): Check[] {
  const checks: Check[] = [];
  const need = (tool: string, fix: string): void => {
    const p = which(tool);
    checks.push(
      p
        ? { name: tool, level: "ok", detail: p }
        : { name: tool, level: "fail", detail: "not found on PATH", fix },
    );
  };

  checks.push(
    process.platform === "linux"
      ? { name: "os", level: "ok", detail: "linux" }
      : {
          name: "os",
          level: "fail",
          detail: `${process.platform} (Linux + systemd required)`,
        },
  );
  need("systemctl", "this tool requires a systemd Linux host");
  need("node", "install Node.js ≥ 22");
  need("git", "install git");
  need("nginx", "install nginx (sudo apt install nginx)");
  need(
    "certbot",
    "install certbot (sudo apt install certbot python3-certbot-nginx)",
  );

  checks.push(...checkAgents());

  checks.push(
    run("sudo", ["-n", "true"]).ok
      ? { name: "sudo", level: "ok", detail: "passwordless sudo available" }
      : {
          name: "sudo",
          level: "warn",
          detail: "sudo will prompt for a password",
          fix: "install needs sudo for systemd/nginx/certbot",
        },
  );
  return checks;
}

// ------------------------------------------------------------------- doctor
export function doctor(cfg: InstallConfig): Check[] {
  const checks: Check[] = [];
  const web = webUnitName();
  const runner = runnerUnitName();

  // services
  checks.push(
    unitActive(web)
      ? { name: `unit ${web}`, level: "ok", detail: "active" }
      : {
          name: `unit ${web}`,
          level: "fail",
          detail: "not active",
          fix: `sudo systemctl status ${web}; journalctl -u ${web} -n 50`,
        },
  );
  checks.push(
    unitActive(runner)
      ? { name: `unit ${runner}`, level: "ok", detail: "active" }
      : {
          name: `unit ${runner}`,
          level: "fail",
          detail: "not active",
          fix: `sudo systemctl status ${runner}; journalctl -u ${runner} -n 50`,
        },
  );

  // runner socket
  checks.push(
    existsSync(cfg.runnerSocket)
      ? { name: "runner socket", level: "ok", detail: cfg.runnerSocket }
      : {
          name: "runner socket",
          level: "warn",
          detail: `${cfg.runnerSocket} missing (web falls back to in-process)`,
        },
  );

  // Agent providers: one valid login is sufficient; unavailable providers stay visible.
  checks.push(...checkAgents(cfg.claudeConfigDir));

  // nginx config
  if (which("nginx")) {
    const t = run("sudo", ["nginx", "-t"]);
    checks.push(
      t.ok
        ? { name: "nginx -t", level: "ok", detail: "config valid" }
        : {
            name: "nginx -t",
            level: "fail",
            detail: t.stderr.trim().split("\n").slice(-1)[0] || "invalid",
            fix: "fix the nginx config, then `sudo nginx -t`",
          },
    );
  }

  // HTTPS is mandatory. Let's Encrypt directories are commonly root-only, so
  // inspect the certificate through the same sudo path doctor already uses for nginx.
  const certPath = `/etc/letsencrypt/live/${cfg.domain}/fullchain.pem`;
  const keyPath = `/etc/letsencrypt/live/${cfg.domain}/privkey.pem`;
  const key = sudo(["test", "-s", keyPath]);
  const cert = sudo([
    "openssl",
    "x509",
    "-checkhost",
    cfg.domain,
    "-enddate",
    "-noout",
    "-in",
    certPath,
  ]);
  const expiry = cert.ok ? /notAfter=(.+)/.exec(cert.stdout) : undefined;
  const expiryMs = expiry ? new Date(expiry[1]).getTime() : Number.NaN;
  if (!key.ok || !expiry || !Number.isFinite(expiryMs)) {
    checks.push({
      name: "TLS cert",
      level: "fail",
      detail: `missing, unreadable, or invalid for ${cfg.domain}`,
      fix: `sudo certbot certonly --nginx -d ${cfg.domain}`,
    });
  } else {
    const days = Math.round((expiryMs - Date.now()) / 86_400_000);
    checks.push(
      days > 14
        ? {
            name: "TLS cert",
            level: "ok",
            detail: `expires in ${days}d (${cfg.domain})`,
          }
        : days >= 0
          ? {
              name: "TLS cert",
              level: "warn",
              detail: `expires in ${days}d`,
              fix: "sudo certbot renew",
            }
          : {
              name: "TLS cert",
              level: "fail",
              detail: `expired ${Math.abs(days)}d ago`,
              fix: "sudo certbot renew --force-renewal",
            },
    );
  }

  // sqlite db
  if (existsSync(cfg.dbPath) && statSync(cfg.dbPath).size > 0) {
    checks.push({ name: "database", level: "ok", detail: cfg.dbPath });
  } else {
    checks.push({
      name: "database",
      level: "warn",
      detail: `${cfg.dbPath} missing/empty (created on first boot)`,
    });
  }

  // VAPID keys (push) — must never be regenerated once present
  const vapid = join(cfg.dataDir, "vapid.json");
  checks.push(
    existsSync(vapid)
      ? {
          name: "VAPID keys",
          level: "ok",
          detail: `${vapid} (never delete — orphans push subscribers)`,
        }
      : {
          name: "VAPID keys",
          level: "warn",
          detail: "not yet generated (created on first boot)",
        },
  );

  // loopback bind
  const ss = run("bash", [
    "-lc",
    `ss -ltn 2>/dev/null | grep -E ':${cfg.port}\\b' || true`,
  ]);
  if (ss.stdout.trim()) {
    const loopback =
      /127(?:\.\d{1,3}){3}/.test(ss.stdout) || ss.stdout.includes("[::1]");
    checks.push(
      loopback
        ? { name: "port bind", level: "ok", detail: `:${cfg.port} on loopback` }
        : {
            name: "port bind",
            level: "warn",
            detail: `:${cfg.port} not bound to loopback — nginx should front it`,
          },
    );
  } else {
    checks.push({
      name: "port bind",
      level: "warn",
      detail: `nothing listening on :${cfg.port}`,
    });
  }

  // PWA static
  const web404 =
    cfg.mode === "package" && cfg.pkgDir
      ? join(cfg.pkgDir, "web", "index.html")
      : undefined;
  if (web404) {
    checks.push(
      existsSync(web404)
        ? { name: "PWA dist", level: "ok", detail: "present" }
        : {
            name: "PWA dist",
            level: "fail",
            detail: "bundled web/ missing",
            fix: "reinstall the package",
          },
    );
  }

  // disk
  const df = run("bash", [
    "-lc",
    `df -Pk ${cfg.dataDir} 2>/dev/null | tail -1 | awk '{print $4}'`,
  ]);
  const freeKb = Number(df.stdout.trim());
  if (freeKb) {
    const gb = (freeKb / 1024 / 1024).toFixed(1);
    checks.push(
      freeKb > 1024 * 1024
        ? { name: "disk", level: "ok", detail: `${gb}G free` }
        : {
            name: "disk",
            level: "warn",
            detail: `${gb}G free — low`,
            fix: "free up disk",
          },
    );
  }

  return checks;
}

// ------------------------------------------------------------------- printer
/** Print a check list; return process exit code (0 ok, 1 if any fail). */
export function printChecks(title: string, checks: Check[]): number {
  log.step(title);
  let failed = 0;
  let warned = 0;
  for (const c of checks) {
    const line = `${c.name.padEnd(22)} ${c.detail}`;
    if (c.level === "ok") log.ok(line);
    else if (c.level === "warn") {
      warned++;
      log.warn(`${line}${c.fix ? `  → ${c.fix}` : ""}`);
    } else {
      failed++;
      log.err(`${line}${c.fix ? `  → ${c.fix}` : ""}`);
    }
  }
  log.plain("");
  if (failed)
    log.err(
      `${failed} failed, ${warned} warning(s) — ${BRANDING.productName} is not healthy.`,
    );
  else if (warned) log.warn(`${warned} warning(s), 0 failures.`);
  else log.ok("all checks passed.");
  return failed ? 1 : 0;
}
