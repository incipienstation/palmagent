import type { UpdateDiscovery, UpdateRequest } from "@palmagent/shared/updates";

export interface UpdateAccessState { discovery: UpdateDiscovery | null; pending: UpdateRequest | null }
// Cache lifetimes never cause a scheduled update check.
export const CHECK_CACHE_MS = 15 * 60 * 1000;
export const FAILED_CHECK_CACHE_MS = 60 * 1000;
