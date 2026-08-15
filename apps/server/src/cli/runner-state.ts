import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
} from "../private-files.js";
import type { InstallConfig } from "./config.js";

const RUNNER_STATE_FILE = "runner-artifact.sha256";

function artifactPaths(cfg: InstallConfig): string[] {
  if (cfg.mode === "package") {
    return cfg.pkgDir ? [join(cfg.pkgDir, "runner-daemon.js")] : [];
  }
  if (!cfg.repoDir) return [];
  return [
    join(cfg.repoDir, "apps", "server", "src", "runner-daemon.ts"),
    join(cfg.repoDir, "apps", "server", "src", "daemon-protocol.ts"),
    join(cfg.repoDir, "apps", "server", "src", "ndjson.ts"),
    join(cfg.repoDir, "apps", "server", "src", "private-files.ts"),
    join(cfg.repoDir, "packages", "shared", "src", "branding.ts"),
  ];
}

export function runnerArtifactFingerprint(
  cfg: InstallConfig,
): string | undefined {
  const paths = artifactPaths(cfg);
  if (!paths.length || paths.some((path) => !existsSync(path))) return undefined;
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function runnerArtifactChanged(cfg: InstallConfig): boolean {
  const current = runnerArtifactFingerprint(cfg);
  if (!current) return true;
  try {
    return readFileSync(join(cfg.dataDir, RUNNER_STATE_FILE), "utf8").trim() !== current;
  } catch {
    return true;
  }
}

export function recordRunnerArtifact(cfg: InstallConfig): void {
  const current = runnerArtifactFingerprint(cfg);
  if (!current) {
    throw new Error("runner artifact is missing; reinstall or rebuild before starting the service");
  }
  ensurePrivateDirectory(cfg.dataDir);
  const path = join(cfg.dataDir, RUNNER_STATE_FILE);
  writeFileSync(path, current + "\n", { mode: 0o600 });
  ensurePrivateFile(path);
}
