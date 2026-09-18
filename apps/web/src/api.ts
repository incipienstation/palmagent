import { invalidateClientReads } from "./read-cache";
import type { AgentKind } from "@palmagent/shared";
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
// (the server maps each value to CLI flags). Re-exported here so the forms keep
// importing it from "../api" alongside MODELS/EFFORTS.
export { PERMISSIONS, DEFAULT_PERMISSION } from "@palmagent/shared";
export type { PermissionOption } from "@palmagent/shared";

// Model choices for dispatch, follow-ups, and routines. Default delegates to the
// server/CLI. Codex availability depends on the account and installed client.
export const DEFAULT_OPTION = "default";

export const MODELS: Record<AgentKind, { value: string; label: string }[]> = {
  claude: [
    { value: DEFAULT_OPTION, label: "default" },
    { value: "opus", label: "opus" },
    { value: "sonnet", label: "sonnet" },
    { value: "haiku", label: "haiku" },
  ],
  codex: [
    { value: DEFAULT_OPTION, label: "default" },
    { value: "gpt-6-astra", label: "gpt-6-astra" },
    { value: "gpt-5.6", label: "gpt-5.6" },
    { value: "gpt-5.6-sol", label: "gpt-5.6-sol" },
    { value: "gpt-5.6-terra", label: "gpt-5.6-terra" },
    { value: "gpt-5.6-luna", label: "gpt-5.6-luna" },
    { value: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark" },
    { value: "gpt-5.5", label: "gpt-5.5" },
  ],
};

export const EFFORTS: Record<AgentKind, { value: string; label: string }[]> = {
  claude: [
    { value: DEFAULT_OPTION, label: "default" },
    { value: "low", label: "low" },
    { value: "medium", label: "medium" },
    { value: "high", label: "high" },
    { value: "xhigh", label: "xhigh" },
    { value: "max", label: "max" },
  ],
  codex: [
    { value: DEFAULT_OPTION, label: "default" },
    { value: "low", label: "low" },
    { value: "medium", label: "medium" },
    { value: "high", label: "high" },
    { value: "xhigh", label: "xhigh" },
  ],
};

// Verified against Codex CLI 0.154.0's model catalog (2026-09-18).
// https://learn.chatgpt.com/docs/models describes Max and Ultra semantics.
// The gpt-5.6 alias targets Sol: https://developers.openai.com/api/docs/models/gpt-5.6-sol
// Default/unknown models use common efforts because the CLI resolves their model.
const CODEX_EXTENDED_EFFORTS: Record<string, string[]> = {
  "gpt-6-astra": ["max", "ultra"],
  "gpt-5.6": ["max", "ultra"],
  "gpt-5.6-sol": ["max", "ultra"],
  "gpt-5.6-terra": ["max", "ultra"],
  "gpt-5.6-luna": ["max"],
};

export function effortsForModel(agent: AgentKind, model: string) {
  return agent === "codex"
    ? [...EFFORTS.codex, ...(CODEX_EXTENDED_EFFORTS[model] ?? []).map((value) => ({ value, label: value }))]
    : EFFORTS.claude;
}

export function selectableModel(agent: AgentKind, model: string): string {
  return agent === "codex" && (model === "gpt-5.4" || model === "gpt-5.4-mini") ? DEFAULT_OPTION : model;
}

export function selectableEffort(agent: AgentKind, model: string, effort: string): string {
  return effortsForModel(agent, model).some((option) => option.value === effort) ? effort : DEFAULT_OPTION;
}
