import type { RepoSettings, RepoSettingsChange } from "@palmagent/shared";
import { RepoSettingsChangeSchema } from "@palmagent/shared/requests";
import { ApplicationError } from "../../../../kernel/errors.js";
import type { SpaceSettings } from "../ports/inbound/space-settings.js";
import type { SpaceSettingsStorage, SpaceSearchPaths, SavedSpaceSettings } from "../ports/outbound/settings.js";

export class SpaceSettingsService implements SpaceSettings {
  constructor(private storage: SpaceSettingsStorage, private paths: SpaceSearchPaths) {}
  private status(saved: SavedSpaceSettings): RepoSettings {
    const defaults = this.storage.defaults();
    return { repoRoots: saved.repoRoots ?? defaults, defaults, source: saved.repoRoots === undefined ? "installation" : "saved" };
  }

  get(): RepoSettings { return this.status(this.storage.readSaved()); }

  change(input: RepoSettingsChange, dryRun = false): RepoSettings {
    const parsed = RepoSettingsChangeSchema.safeParse(input);
    if (!parsed.success) throw new ApplicationError("bad_request", "Invalid Space search settings.");
    const change = parsed.data;
    let release: (() => void) | undefined;
    try {
      if (!dryRun) release = this.storage.lock();
      const saved = this.storage.readSaved();
      if (change.action === "reset") {
        delete saved.repoRoots;
      } else {
        const paths = [...new Set(change.paths.map((path) => {
          const normalized = this.paths.normalize(path);
          // Removal must still work after a drive is unmounted or a folder deleted.
          if (change.action !== "remove") this.paths.assertReadable(normalized);
          return normalized;
        }))];
        const current = this.status(saved).repoRoots;
        saved.repoRoots = change.action === "set" ? paths
          : change.action === "add" ? [...new Set([...current, ...paths])]
          : current.filter((path) => !paths.includes(path));
        if (saved.repoRoots.length > 64) throw new ApplicationError("bad_request", "Use at most 64 search folders.");
      }
      const result = this.status(saved);
      if (!dryRun) this.storage.write(saved);
      return result;
    } finally { release?.(); }
  }
}
