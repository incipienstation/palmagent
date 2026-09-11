// Shared preferences for both operator plugins. Kept outside plugin/package caches.
import {
  closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensurePrivateParent } from "../private-files.js";
import { installEnvPath, parseEnvFile, resolveDataDir } from "./config.js";
import { productVersion, releaseChannel, type ReleaseChannel } from "./release-policy.js";

const UserConfigSchema = z.object({
  schemaVersion: z.literal(1),
  channel: z.enum(["stable", "preview"]),
}).passthrough();

export type UserConfig = z.infer<typeof UserConfigSchema>;
type Options = { dataDir?: string; dryRun?: boolean };

export function userConfigPath(): string {
  const home = process.env.PALMAGENT_HOME ?? join(homedir(), ".palmagent");
  if (!isAbsolute(home)) throw new Error("PALMAGENT_HOME must be an absolute directory");
  return join(home, "config.json");
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function readSaved(): UserConfig | undefined {
  const path = userConfigPath();
  try {
    if (!lstatSync(path).isFile()) throw new Error("not a regular file");
    return UserConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (missing(error)) return undefined;
    // Do not include parser errors: they can contain private settings values.
    throw new Error(`cannot read user settings at ${path}: expected a regular JSON file with schemaVersion 1 and channel stable or preview; existing settings were preserved`);
  }
}

function legacyChannel(dataDir?: string): ReleaseChannel {
  let env: Record<string, string>;
  try {
    env = parseEnvFile(readFileSync(installEnvPath(resolveDataDir(dataDir)), "utf8"));
  } catch (error) {
    if (missing(error)) return "stable";
    throw new Error("cannot read legacy installation settings; user settings were not initialized");
  }
  if (env.RELEASE_CHANNEL !== undefined) return releaseChannel(env.RELEASE_CHANNEL);
  if (env.MODE !== "source" && env.PKG_DIR) {
    try {
      const pkg = JSON.parse(readFileSync(join(env.PKG_DIR, "package.json"), "utf8"));
      return productVersion(pkg.version).prerelease ? "preview" : "stable";
    } catch {
      throw new Error("cannot infer the legacy release channel from package metadata; choose a channel explicitly through plugin settings");
    }
  }
  return "stable";
}

/** Read-only, including the legacy/default fallback when no user file exists. */
export function getUserConfig(options: Options = {}): UserConfig {
  return readSaved() ?? { schemaVersion: 1, channel: legacyChannel(options.dataDir) };
}

function writeAtomic(config: UserConfig, createOnly: boolean): void {
  const path = userConfigPath();
  const directory = dirname(path);
  try {
    if (lstatSync(directory).isSymbolicLink()) throw new Error("user settings directory cannot be a symbolic link");
  } catch (error) { if (!missing(error)) throw error; }
  ensurePrivateParent(directory);
  const temp = join(directory, `.config-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(config, null, 2) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (createOnly) {
      // An initializer must never overwrite a choice saved by another session.
      try { linkSync(temp, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } else {
      renameSync(temp, path);
    }
    const parent = openSync(directory, "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (!missing(error)) throw error; }
  }
}

/** Create/migrate once. Existing user preferences always win over install.env. */
export function initUserConfig(options: Options = {}): UserConfig {
  const saved = readSaved();
  if (saved) return saved;
  const config = getUserConfig(options);
  if (options.dryRun) return config;
  writeAtomic(config, true);
  const persisted = readSaved();
  if (!persisted) throw new Error("user settings disappeared during initialization");
  return persisted;
}

/** Plugin-controlled preference change; does not install or restart anything. */
export function setUserChannel(value: string, options: Options = {}): UserConfig {
  const channel = releaseChannel(value);
  // Explicit choice can recover a missing legacy package, but never invalid JSON.
  const config = { ...(readSaved() ?? { schemaVersion: 1 as const }), channel };
  if (options.dryRun) return config;
  writeAtomic(config, false);
  return config;
}

/** Service data removal must never include the shared preferences directory. */
export function assertUserConfigPreserved(dataDir: string): void {
  const within = relative(resolve(dataDir), userConfigPath());
  if (within === "" || (within !== ".." && !within.startsWith(".." + sep) && !isAbsolute(within))) {
    throw new Error("refusing to purge a directory containing shared Palmagent user settings");
  }
}
