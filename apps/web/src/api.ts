import { invalidateClientReads } from "./read-cache";
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
export async function probeAuth(): Promise<void> {
  try {
    const me = await api.auth.me();
    if (me.required && !me.authenticated) { invalidateClientReads(true); onUnauthorized?.(); }
  } catch {
    /* network hiccup — not an auth problem */
  }
}

// Per-agent permission catalog + per-agent default live in the shared contract
// (the server maps each value to CLI flags). Re-exported here so the forms can
// keep importing permissions from "../api".
export { PERMISSIONS, DEFAULT_PERMISSION, PERMISSION_CLI_FLAG } from "@palmagent/shared";
export type { PermissionOption } from "@palmagent/shared";

// Default delegates to the server/CLI. The Codex model catalog is loaded from the
// installed App Server at runtime; see model-catalog.tsx.
export const DEFAULT_OPTION = "default";
