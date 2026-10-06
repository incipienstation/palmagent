import { accessSync, constants, lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { RepoRootsSchema } from "@palmagent/shared/requests";
import type { SpaceSettingsStorage, SpaceSearchPaths, SavedSpaceSettings } from "../../application/ports/outbound/settings.js";
import { parseEnvFile } from "../../../../platform/filesystem/env-file.js";
import { acquireUpdateLock, UpdateBusyError } from "../../../../platform/filesystem/update-lock.js";
import { expandHome } from "../../../../platform/filesystem/paths.js";
import { writePrivateFileAtomic } from "../../../../platform/filesystem/private-files.js";
import { ApplicationError } from "../../../../kernel/errors.js";

const SavedSettings = z.object({ schemaVersion: z.literal(1), repoRoots: RepoRootsSchema.optional() }).passthrough();

export function parseRepoRoots(value: string): string[] {
  return [...new Set(value.split(":").map((path) => path.trim()).filter(Boolean).map((path) => resolve(expandHome(path))))];
}

/** Per-installation preferences shared by the web server and local CLI. Reads
 * stay live so another process's atomic write takes effect on the next request. */
export class SettingsStore implements SpaceSettingsStorage, SpaceSearchPaths {
  readonly path: string;
  constructor(readonly dataDir: string, private readonly fallbackRoots: string[] = []) {
    this.path = join(dataDir, "settings.json");
  }

  readSaved(): z.infer<typeof SavedSettings> {
    try {
      if (!lstatSync(this.path).isFile()) throw new Error("not a regular file");
      const saved = SavedSettings.parse(JSON.parse(readFileSync(this.path, "utf8")));
      if (saved.repoRoots?.some((path) => !isAbsolute(path))) throw new Error("not an absolute path");
      return saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1 };
      throw new ApplicationError("service_unavailable", "Cannot read saved Space search settings. Existing settings were preserved.");
    }
  }

  defaults(): string[] {
    try {
      const env = parseEnvFile(readFileSync(join(this.dataDir, "install.env"), "utf8"));
      return parseRepoRoots(env.REPO_ROOTS ?? "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [...this.fallbackRoots];
      throw new ApplicationError("service_unavailable", "Cannot read installation search paths.");
    }
  }

  write(saved: SavedSpaceSettings): void { writePrivateFileAtomic(this.path, JSON.stringify(saved, null, 2) + "\n"); }
  lock(): () => void {
    try { return acquireUpdateLock(this.dataDir); }
    catch (error) { if (error instanceof UpdateBusyError) throw new ApplicationError("conflict", error.message); throw error; }
  }
  normalize(path: string): string {
    const expanded = expandHome(path);
    if (!isAbsolute(expanded)) throw new ApplicationError("bad_request", "Use an absolute path or ~/ for each search folder.");
    return resolve(expanded);
  }
  assertReadable(path: string): void {
    try {
      if (!statSync(path).isDirectory()) throw new Error("not a directory");
      accessSync(path, constants.R_OK | constants.X_OK);
    } catch { throw new ApplicationError("bad_request", `Search folder is missing or inaccessible: ${path}`); }
  }
}
