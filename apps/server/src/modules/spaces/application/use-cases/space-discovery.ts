import type { DiscoverReposResponse, ValidateRepoPathResponse } from "@palmagent/shared";
import { repositorySuggestions } from "../../domain/repository-suggestions.js";
import type { SpaceDiscovery } from "../ports/outbound/discovery.js";
import type { SpaceDiscoveryUseCases } from "../ports/inbound/space-discovery.js";
import type { SpaceSettings } from "../ports/inbound/space-settings.js";
import type { SpaceUseCases } from "../ports/inbound/space-use-cases.js";

export class SpaceDiscoveryService implements SpaceDiscoveryUseCases {
  constructor(private discovery: SpaceDiscovery, private settings: Pick<SpaceSettings, "get">,
    private spaces: Pick<SpaceUseCases, "listRepos">) {}
  discover(refresh: boolean): DiscoverReposResponse {
    const roots = this.settings.get().repoRoots;
    const result = this.discovery.scan(roots, refresh);
    const registered = new Map(this.spaces.listRepos().map(repo => [repo.path, repo.id]));
    return { repos: result.repos.map(repo => { const repoId = registered.get(repo.path); return repoId ? { ...repo, repoId } : repo; }), roots, scannedAt: result.scannedAt };
  }
  validate(path: string): ValidateRepoPathResponse {
    const roots = this.settings.get().repoRoots;
    const registered = this.spaces.listRepos();
    const inspected = this.discovery.inspect(path);
    const result: ValidateRepoPathResponse = { input: path, resolved: inspected.resolved,
      exists: inspected.exists, isDir: inspected.isDir, isGit: Boolean(inspected.root), suggestions: [] };
    if (inspected.root) {
      result.root = inspected.root;
      result.branch = inspected.branch;
      const repo = registered.find(repo => repo.path === inspected.root);
      if (repo) result.repoId = repo.id;
    } else if (inspected.isDir) {
      // Plain folders register as-is and do not need typo suggestions.
      const repo = registered.find(repo => repo.path === inspected.resolved);
      if (repo) result.repoId = repo.id;
    } else {
      result.suggestions = repositorySuggestions(inspected.name, this.discovery.scan(roots, false).repos);
    }
    return result;
  }
  browse(path?: string) { return this.discovery.browse(path, this.settings.get().repoRoots); }
}
