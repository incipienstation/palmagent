import type { DiscoverReposResponse, FsListResponse, ValidateRepoPathResponse } from "@palmagent/shared";
export interface SpaceDiscoveryUseCases {
  discover(refresh: boolean): DiscoverReposResponse;
  validate(path: string): ValidateRepoPathResponse;
  browse(path?: string): FsListResponse;
}
