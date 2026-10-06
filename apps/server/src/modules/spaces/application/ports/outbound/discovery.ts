import type { DiscoveredRepo, FsListResponse, Repo, ValidateRepoPathResponse } from "@palmagent/shared";

export interface SpaceDiscovery {
  scan(roots: string[], refresh: boolean): { repos: Omit<DiscoveredRepo, "repoId">[]; scannedAt: number };
  validate(path: string, roots: string[], registered: Repo[]): ValidateRepoPathResponse;
  browse(path: string | undefined, roots: string[]): FsListResponse;
}
