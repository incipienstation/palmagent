import type { DiscoveredRepo, FsListResponse } from "@palmagent/shared";

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
