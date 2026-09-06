import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BRANDING } from "@palmagent/shared";
import { expandHome } from "./paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isLoopbackHost = (value: string): boolean =>
  value === "localhost" || value === "::1" || /^127(?:\.\d{1,3}){3}$/.test(value);

// Declarative env schema (zod). Parsed ONCE at import: it coerces + validates the
// operational knobs and applies universally-safe defaults. It deliberately does
// NOT enforce the conditionally-required identity (AUTH_RP_ID) — that is a boot
// check (validateConfig) so tooling/tests that import `config` never throw.
//
// No host-/person-specific defaults live here: identity (the public domain) is
// required in production and `localhost` in dev; the Web Push contact has no
// default (unset ⇒ push disabled); repo-scan roots have no default (unset ⇒ off).
const Env = z
  .object({
    PORT: z.coerce.number().int().positive().default(4000),
    HOST: z
      .string()
      .min(1)
      .refine(isLoopbackHost, "HOST must be loopback; terminate public HTTPS at the reverse proxy")
      .default("localhost"),
    DISPATCH_CONCURRENCY: z.coerce.number().int().min(1).default(8),
    SSE_KEEPALIVE_MS: z.coerce.number().int().positive().default(15000),
    AUTH_SESSION_TTL_MS: z.coerce.number().int().positive().default(30 * 24 * 60 * 60 * 1000),
    AUTH_COOKIE_NAME: z.string().min(1).default("palmagent_session"),
    // Identity. Optional at parse; AUTH_RP_ID is required-when-authEnabled via
    // validateConfig(). origin + name derive from it.
    AUTH_RP_ID: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9.-]+$/, "AUTH_RP_ID must be a hostname without a scheme, path, or port")
      .optional(),
    AUTH_RP_NAME: z.string().min(1).optional(),
    AUTH_ORIGIN: z.string().url().startsWith("https://", "AUTH_ORIGIN must use https://").optional(),
    AUTH_ENABLED: z.string().optional(),
    AUTH_DISABLED: z.string().optional(),
    // Web Push (VAPID) contact. Optional, NO default — unset ⇒ push disabled.
    PUSH_SUBJECT: z
      .string()
      .regex(/^(mailto:|https:\/\/)/, "PUSH_SUBJECT must be a mailto: or https:// URL")
      .optional(),
    // Paths. The data dir anchors DB + VAPID keys; everything is optional/derived.
    DISPATCHER_DATA_DIR: z.string().min(1).optional(),
    XDG_STATE_HOME: z.string().min(1).optional(),
    DISPATCHER_DB: z.string().min(1).optional(),
    VAPID_KEY_PATH: z.string().min(1).optional(),
    STATIC_DIR: z.string().min(1).optional(),
    REPO_ROOTS: z.string().optional(), // no default — empty ⇒ repo-discovery scan off
    // GitHub PR status (github.ts). Optional — unset ⇒ fall back to the host's
    // `gh auth token`; with neither, PRs stay plain links (status fetch off).
    GITHUB_TOKEN: z.string().min(1).optional(),
    // Optional features — unset ⇒ off / CLI default.
    RUNNER_SOCKET: z.string().min(1).optional(),
    CLAUDE_MODEL: z.string().min(1).optional(),
    CODEX_MODEL: z.string().min(1).optional(),
    CLAUDE_EFFORT: z.string().min(1).optional(),
    CODEX_EFFORT: z.string().min(1).optional(),
    // Claude CLI's own config/credentials dir (its `CLAUDE_CONFIG_DIR`). Unset ⇒
    // the CLI's own default (~/.claude) — set this to isolate the dispatcher's
    // headless Claude sessions from an interactively-used ~/.claude on the same
    // host. Installers should persist it in the service environment.
    CLAUDE_CONFIG_DIR: z.string().min(1).optional(),
    NODE_ENV: z.string().optional(),
  })
  .passthrough();

// Treat empty-string env vars as unset (matches shell/systemd `FOO=` semantics)
// so optionals/defaults apply instead of a zod min(1) error.
function definedEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined && v !== "") out[k] = v;
  return out;
}

const env = Env.parse(definedEnv(process.env));

// Auth enabled: explicit override wins, else on in production.
const authEnabled =
  env.AUTH_DISABLED === "1" ? false : env.AUTH_ENABLED === "1" ? true : env.NODE_ENV === "production";

// Identity anchor — NO personal/host default. Required in prod (validateConfig),
// `localhost` in dev. Everything identity-related derives from it.
const rpId = env.AUTH_RP_ID ?? (authEnabled ? "" : "localhost");

// Persistent state dir (XDG): DISPATCHER_DATA_DIR > $XDG_STATE_HOME/<name> > ~/.local/state/<name>.
const dataDir = env.DISPATCHER_DATA_DIR
  ? resolve(env.DISPATCHER_DATA_DIR)
  : env.XDG_STATE_HOME
    ? join(resolve(env.XDG_STATE_HOME), BRANDING.stateDirName)
    : join(homedir(), ".local", "state", BRANDING.stateDirName);

const palmagentDbPath = join(dataDir, "palmagent.db");
const legacyDbPath = join(dataDir, "dispatcher.db");
// Clean installs use the product-named database. Existing installations keep
// using their database in place until an explicit data migration moves it.
const dbPath = env.DISPATCHER_DB
  ? resolve(env.DISPATCHER_DB)
  : existsSync(palmagentDbPath) || !existsSync(legacyDbPath)
    ? palmagentDbPath
    : legacyDbPath;

export const config = {
  port: env.PORT,
  host: env.HOST,
  concurrency: env.DISPATCH_CONCURRENCY,
  dataDir,
  dbPath,
  keepAliveMs: env.SSE_KEEPALIVE_MS,
  // Optional default model / reasoning effort per agent (task-level overrides win).
  claudeModel: env.CLAUDE_MODEL,
  codexModel: env.CODEX_MODEL,
  claudeEffort: env.CLAUDE_EFFORT,
  codexEffort: env.CODEX_EFFORT,
  // Claude CLI config/credentials dir override. Unset ⇒ the CLI's own default (~/.claude).
  claudeConfigDir: env.CLAUDE_CONFIG_DIR ? resolve(expandHome(env.CLAUDE_CONFIG_DIR)) : undefined,
  // VAPID keys live next to the DB unless overridden (co-located so they persist;
  // never regenerate them — that orphans every push subscriber).
  vapidKeyPath: env.VAPID_KEY_PATH ? resolve(env.VAPID_KEY_PATH) : join(dirname(dbPath), "vapid.json"),
  // Web Push (VAPID) contact — unset ⇒ push disabled (no fabricated default).
  pushSubject: env.PUSH_SUBJECT,
  // Built PWA dir: explicit, else package-relative (served only if it exists).
  staticDir: env.STATIC_DIR ? resolve(env.STATIC_DIR) : join(__dirname, "..", "..", "web", "dist"),
  // Repo-discovery scan roots (colon-separated). No default — empty ⇒ discovery off.
  repoRoots: (env.REPO_ROOTS ?? "")
    .split(":")
    .filter(Boolean)
    .map((p) => resolve(expandHome(p))),
  // Runner daemon socket. Unset ⇒ spawn CLIs in-process.
  runnerSocket: env.RUNNER_SOCKET,
  // GitHub token for PR status (github.ts). Unset ⇒ try `gh auth token`.
  githubToken: env.GITHUB_TOKEN,

  // ---- in-app WebAuthn auth ----
  authEnabled,
  rpId,
  // App-facing: surfaces in the browser's native passkey dialog, so match the UI brand.
  rpName: env.AUTH_RP_NAME ?? BRANDING.displayName,
  // authOrigin derives from rpId (deterministic); override only for a nonstandard origin.
  authOrigin: env.AUTH_ORIGIN ?? (rpId ? `https://${rpId}` : ""),
  sessionTtlMs: env.AUTH_SESSION_TTL_MS,
  cookieName: env.AUTH_COOKIE_NAME,
  nodeEnv: env.NODE_ENV,
};

// Fail-fast: the conditionally-required identity check. Called at server boot
// (server.ts), never at import — so importing `config` is side-effect-free. We
// refuse to start rather than silently fall back to any host/person literal.
export function validateConfig(): void {
  const missing: string[] = [];
  if (config.authEnabled && !env.AUTH_RP_ID) {
    missing.push(
      "AUTH_RP_ID — your public domain (e.g. dispatch.example.com); the WebAuthn RP id + origin derive from it",
    );
  }
  if (missing.length) {
    throw new Error(
      `${BRANDING.productName}: missing required configuration —\n` +
        missing.map((m) => `  • ${m}`).join("\n") +
        `\nSet it in the service environment and restart.`,
    );
  }
}
