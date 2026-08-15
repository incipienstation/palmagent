import type { AgentKind } from "./events.js";

// Per-agent permission catalog. Permission is PER-AGENT (like model/effort), not a
// shared enum: Claude has a single `--permission-mode` axis, while Codex (headless
// `codex exec`, approval_policy pinned to "never") varies only by sandbox + network.
// This catalog is the single source of truth for the vocabulary, UI labels, and the
// per-agent default; each server adapter maps a value to that CLI's flags (Strategy)
// and tolerates older/unknown values by falling back to the default. The wire field
// is an opaque string (see `Permission` in task.ts) — exactly like `model`.

export interface PermissionOption {
  value: string; // wire value — also the CLI-native token the adapter maps
  label: string; // short label for the Select trigger (kept compact for mobile)
  description: string; // one-line explanation shown in the dropdown row
  danger?: boolean; // no-guardrails tier — the UI flags it
}

export const PERMISSIONS: Record<AgentKind, PermissionOption[]> = {
  // Claude `--permission-mode` values, verbatim (verified accepted by claude 2.1.183:
  // acceptEdits | auto | bypassPermissions | default | dontAsk | plan).
  claude: [
    { value: "plan", label: "Plan", description: "Explore only — proposes changes, makes none" },
    { value: "acceptEdits", label: "Accept edits", description: "Auto-applies edits in the workspace; other tools still gated" },
    { value: "dontAsk", label: "Don't ask", description: "Denies anything not pre-allowed (strict, no prompts)" },
    { value: "bypassPermissions", label: "Bypass", description: "No prompts — only .git/.claude stay protected", danger: true },
  ],
  // Codex sandbox tiers. approval_policy is always "never" (exec is headless — no one
  // to approve), so the only axis is sandbox_mode + workspace-write network_access.
  codex: [
    { value: "read-only", label: "Read-only", description: "Inspect only — no writes, no network" },
    { value: "workspace-write", label: "Workspace", description: "Edit the workspace; network off" },
    { value: "workspace-write-net", label: "Workspace +net", description: "Edit the workspace + network on (gh, fetch, install)" },
    { value: "danger-full-access", label: "Full access", description: "No sandbox + network — full host access", danger: true },
  ],
};

// The default permission per agent: the form's starting value AND the server's
// fallback when a request omits permission. The conservative defaults remain
// acceptEdits / workspace-write and must name values present above.
export const DEFAULT_PERMISSION: Record<AgentKind, string> = {
  claude: "acceptEdits",
  codex: "workspace-write",
};

export function defaultPermission(agent: AgentKind): string {
  return DEFAULT_PERMISSION[agent];
}
