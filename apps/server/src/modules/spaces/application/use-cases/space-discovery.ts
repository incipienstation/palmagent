import type { DiscoverReposResponse, ValidateRepoPathResponse } from "@palmagent/shared";
import { repositorySuggestions } from "../../domain/repository-suggestions.js";
import type { SpaceDiscovery, SpaceDiscoveryCatalog } from "../ports/outbound/discovery.js";
import type { SpaceDiscoveryUseCases } from "../ports/inbound/space-discovery.js";
import type { SpaceSettings } from "../ports/inbound/space-settings.js";

export class SpaceDiscoveryService implements SpaceDiscoveryUseCases {
  constructor(private discovery: SpaceDiscovery, private settings: Pick<SpaceSettings, "get">,
    private catalog: SpaceDiscoveryCatalog) {}
  discover(refresh: boolean): DiscoverReposResponse {
    const roots = this.settings.get().repoRoots;
    const result = this.discovery.scan(roots, refresh);
    const paths = [...new Set(result.repos.map(repo => repo.path))];
    const registered = new Map(paths.length ? this.catalog.discoveredRepoIds(paths) : []);
    return { repos: result.repos.map(repo => { const repoId = registered.get(repo.path); return repoId ? { ...repo, repoId } : repo; }), roots, scannedAt: result.scannedAt };
  }
  validate(path: string): ValidateRepoPathResponse {
    const roots = this.settings.get().repoRoots;
    const inspected = this.discovery.inspect(path);
    const result: ValidateRepoPathResponse = { input: path, resolved: inspected.resolved,
      exists: inspected.exists, isDir: inspected.isDir, isGit: Boolean(inspected.root), suggestions: [] };
    if (inspected.root) {
      result.root = inspected.root;
      result.branch = inspected.branch;
    }
    if (inspected.root || inspected.isDir) {
      const canonical = inspected.root || inspected.resolved;
      const repo = this.catalog.getRepoByPath(canonical);
      if (repo?.path === canonical) result.repoId = repo.id;
    } else {
      result.suggestions = repositorySuggestions(inspected.name, this.discovery.scan(roots, false).repos);
    }
    return result;
  }
  browse(path?: string) { return this.discovery.browse(path, this.settings.get().repoRoots); }
}
