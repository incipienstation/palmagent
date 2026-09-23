import type { AgentKind } from "./events.js";

// Per-agent permission catalog. Permission is PER-AGENT (like model/effort), not a
// shared enum: Claude has a single `--permission-mode` axis, while Codex's headless
// `codex exec` uses its native `--sandbox` axis (approval_policy is pinned to "never").
// This catalog is the single source of truth for the vocabulary, UI labels, and the
// per-agent default; each server adapter maps a value to that CLI's flags (Strategy)
// and tolerates older/unknown values by falling back to the default. The wire field
// is an opaque string (see `Permission` in task.ts) — exactly like `model`.

export interface PermissionOption {
  value: string; // wire value — also the CLI-native token the adapter maps
  label: string; // short label for the picker
  description: string; // plain-language effect shown beside the value
  danger?: boolean; // no-guardrails tier — the UI flags it
}

// These are the native CLI flags represented by the catalog below. Keep this
// separate from adapter implementation so the UI can show provider vocabulary
// without duplicating it in each form.
export const PERMISSION_CLI_FLAG: Record<AgentKind, string> = {
  claude: "--permission-mode",
  codex: "--sandbox",
};

export const PERMISSIONS: Record<AgentKind, PermissionOption[]> = {
  // Claude `--permission-mode` values, verbatim from the supported CLI lane:
  // acceptEdits | auto | bypassPermissions | manual | dontAsk | plan.
  claude: [
    { value: "plan", label: "Plan", description: "Explore only — proposes changes, makes none" },
    { value: "auto", label: "Auto", description: "Claude decides which low-risk actions can run automatically" },
    { value: "acceptEdits", label: "Accept edits", description: "Auto-applies edits in the workspace; other tools still gated" },
    { value: "manual", label: "Manual", description: "Ask before a permission-gated tool action" },
    { value: "dontAsk", label: "Don't ask", description: "Denies anything not pre-allowed (strict, no prompts)" },
    { value: "bypassPermissions", label: "Bypass", description: "Skip permission checks for this session", danger: true },
  ],
  // Codex `exec --sandbox` values, verbatim. Palmagent pins approval_policy to
  // "never" because exec has no approval channel; sandbox is the permission axis.
  codex: [
    { value: "read-only", label: "Read-only", description: "Inspect files without workspace writes" },
    { value: "workspace-write", label: "Workspace", description: "Edit files inside the workspace sandbox" },
    { value: "danger-full-access", label: "Full access", description: "Disable the filesystem sandbox", danger: true },
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
