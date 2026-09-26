import { accessSync, constants, lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { RepoRootsSchema, RepoSettingsChangeSchema } from "@palmagent/shared/requests";
import type { RepoSettings, RepoSettingsChange } from "@palmagent/shared";
import { parseEnvFile } from "./env-file.js";
import { acquireUpdateLock, UpdateBusyError } from "./update-lock.js";
import { expandHome } from "./paths.js";
import { writePrivateFileAtomic } from "./private-files.js";
import { ApplicationError } from "./errors.js";

const SavedSettings = z.object({ schemaVersion: z.literal(1), repoRoots: RepoRootsSchema.optional() }).passthrough();

export function parseRepoRoots(value: string): string[] {
  return [...new Set(value.split(":").map((path) => path.trim()).filter(Boolean).map((path) => resolve(expandHome(path))))];
}

/** Per-installation preferences shared by the web server and local CLI. Reads
 * stay live so another process's atomic write takes effect on the next request. */
export class SettingsStore {
  readonly path: string;
  constructor(readonly dataDir: string, private readonly fallbackRoots: string[] = []) {
    this.path = join(dataDir, "settings.json");
  }

  private readSaved(): z.infer<typeof SavedSettings> {
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

  private defaults(): string[] {
    try {
      const env = parseEnvFile(readFileSync(join(this.dataDir, "install.env"), "utf8"));
      return parseRepoRoots(env.REPO_ROOTS ?? "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [...this.fallbackRoots];
      throw new ApplicationError("service_unavailable", "Cannot read installation search paths.");
    }
  }

  private status(saved: z.infer<typeof SavedSettings>): RepoSettings {
    const defaults = this.defaults();
    return { repoRoots: saved.repoRoots ?? defaults, defaults, source: saved.repoRoots === undefined ? "installation" : "saved" };
  }

  get(): RepoSettings { return this.status(this.readSaved()); }

  change(input: RepoSettingsChange, dryRun = false): RepoSettings {
    const parsed = RepoSettingsChangeSchema.safeParse(input);
    if (!parsed.success) throw new ApplicationError("bad_request", "Invalid Space search settings.");
    const change = parsed.data;
    let release: (() => void) | undefined;
    try {
      if (!dryRun) {
        try { release = acquireUpdateLock(this.dataDir); }
        catch (error) {
          if (error instanceof UpdateBusyError) throw new ApplicationError("conflict", error.message);
          throw error;
        }
      }
      const saved = this.readSaved();
      if (change.action === "reset") {
        delete saved.repoRoots;
      } else {
        const paths = [...new Set(change.paths.map((path) => {
          const expanded = expandHome(path);
          if (!isAbsolute(expanded)) throw new ApplicationError("bad_request", "Use an absolute path or ~/ for each search folder.");
          const normalized = resolve(expanded);
          // Removal must still work after a drive is unmounted or a folder deleted.
          if (change.action !== "remove") {
            try {
              if (!statSync(normalized).isDirectory()) throw new Error("not a directory");
              accessSync(normalized, constants.R_OK | constants.X_OK);
            } catch { throw new ApplicationError("bad_request", `Search folder is missing or inaccessible: ${normalized}`); }
          }
          return normalized;
        }))];
        const current = this.status(saved).repoRoots;
        saved.repoRoots = change.action === "set" ? paths
          : change.action === "add" ? [...new Set([...current, ...paths])]
          : current.filter((path) => !paths.includes(path));
        if (saved.repoRoots.length > 64) throw new ApplicationError("bad_request", "Use at most 64 search folders.");
      }
      const result = this.status(saved);
      if (!dryRun) writePrivateFileAtomic(this.path, JSON.stringify(saved, null, 2) + "\n");
      return result;
    } finally { release?.(); }
  }
}
