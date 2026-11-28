import { cacheSession, invalidateClientReads } from "./query-lifecycle";
import { createApi } from "./api-client";
import { beginBrowserWork } from "./update-state";
import { clientVersion, observeServerVersion } from "./pwa";
export { ApiError } from "./api-client";

let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

export const api = createApi({
  version: () => clientVersion,
  observeServerVersion,
  beginBrowserWork,
  onUnauthorized: () => onUnauthorized?.(),
});

// EventSource only surfaces an opaque error, never a 401, so on a stream failure
// the hooks call this to tell "logged out" (→ show login) apart from a transient
// network/proxy blip (→ keep reconnecting).
let probe: { generation: number; promise: Promise<void> } | undefined;
export function probeAuth(): Promise<void> {
  const generation = cacheSession();
  if (probe?.generation === generation) return probe.promise;
  const promise = api.auth.me().then(me => {
    if (generation === cacheSession() && me.required && !me.authenticated) {
      invalidateClientReads(true);
      onUnauthorized?.();
    }
  }).catch(() => { /* A network interruption does not change the session. */ })
    .finally(() => { if (probe?.promise === promise) probe = undefined; });
  probe = { generation, promise };
  return promise;
}

// Per-agent permission catalog + per-agent default live in the shared contract
// (the server maps each value to CLI flags). Re-exported here so the forms can
// keep importing permissions from "../api".
export { PERMISSIONS, DEFAULT_PERMISSION, PERMISSION_CLI_FLAG } from "@palmagent/shared";
export type { PermissionOption } from "@palmagent/shared";

// Default delegates to the server/CLI for both providers.
export const DEFAULT_OPTION = "default";
