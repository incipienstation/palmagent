import type { DiscoveredRepo, FsListResponse } from "@palmagent/shared";

export interface SpaceDiscoveryCatalog {
  /** Newest registration for each matching path, as in the discovery list. */
  discoveredRepoIds(paths: string[]): [string, string][];
  /** Manual validation resolves an older duplicate to its first registration. */
  getRepoByPath(path: string): { path: string; id: string } | undefined;
}

export interface DiscoveryPathInspection {
  resolved: string;
  name: string;
  exists: boolean;
  isDir: boolean;
  root?: string;
  branch?: string;
}
export interface SpaceDiscovery {
  scan(roots: string[], refresh: boolean): { repos: Omit<DiscoveredRepo, "repoId">[]; scannedAt: number };
  inspect(path: string): DiscoveryPathInspection;
  browse(path: string | undefined, roots: string[]): FsListResponse;
}
