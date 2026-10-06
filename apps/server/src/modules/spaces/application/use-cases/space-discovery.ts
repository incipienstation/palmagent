import type { SpaceDiscovery } from "../ports/outbound/discovery.js";
import type { SpaceDiscoveryUseCases } from "../ports/inbound/space-discovery.js";
import type { SpaceSettings } from "../ports/inbound/space-settings.js";
import type { SpaceUseCases } from "../ports/inbound/space-use-cases.js";

export class SpaceDiscoveryService implements SpaceDiscoveryUseCases {
  constructor(private discovery: SpaceDiscovery, private settings: Pick<SpaceSettings, "get">,
    private spaces: Pick<SpaceUseCases, "listRepos">) {}
  discover(refresh: boolean) {
    const roots = this.settings.get().repoRoots;
    const result = this.discovery.scan(roots, refresh);
    const registered = new Map(this.spaces.listRepos().map(repo => [repo.path, repo.id]));
    return { repos: result.repos.map(repo => { const repoId = registered.get(repo.path); return repoId ? { ...repo, repoId } : repo; }), roots, scannedAt: result.scannedAt };
  }
  validate(path: string) { return this.discovery.validate(path, this.settings.get().repoRoots, this.spaces.listRepos()); }
  browse(path?: string) { return this.discovery.browse(path, this.settings.get().repoRoots); }
}
