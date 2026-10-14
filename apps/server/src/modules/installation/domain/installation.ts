import type { UpdateChannel } from "@palmagent/shared";

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
  /** Retained Node runtime; presence enables independent execution hosts. */
  executionNode?: string;
  /** Missing on legacy installations; migration happens through an idle setup. */
  supervisor?: "palmagentd";
  /** Absent on existing native installations, which keep their system bootstrap until setup. */
  daemonScope?: "user" | "system";
  /** Persist the user unit directory so removal does not depend on the caller's XDG environment. */
  daemonUnitDir?: string;
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
