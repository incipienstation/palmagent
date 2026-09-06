import type { AgentKind, QuestionRequest } from "./events.js";

// Task lifecycle. `idle` = turn done, no process held, resumable;
// `interrupted` flags a turn that was cut short (usually recovered after a
// restart) — the task is still resumable.
export type TaskStatus =
  | "queued" // accepted, waiting for a concurrency slot
  | "running" // a child process is alive for the active turn
  | "awaiting_approval" // paused on an approval request (rare under our non-interactive modes)
  | "awaiting_input" // paused on an AskUserQuestion — the agent needs the user to answer (Claude)
  | "idle" // turn finished, no process held, resumable via follow-up
  | "archived" // retired by the user; worktree removed
  | "failed" // turn errored / nonzero exit
  | "cancelled"; // SIGINT'd by the user; worktree removed

// How much autonomy the agent gets for a turn. PER-AGENT vocabulary (like model/
// effort), carried as an opaque string on the wire; each adapter maps it to that
// CLI's flags. See PERMISSIONS / DEFAULT_PERMISSION in permissions.ts for the
// catalog + per-agent default (Claude `--permission-mode`; Codex sandbox + network).
// Older rows may still hold the former shared enum ("readonly" | "auto-edit" | "full");
// each adapter normalizes those to its native vocabulary.
export type Permission = string;

// A registered local directory. Git repos (`vcs: "git"`) fork a per-task
// worktree from `defaultBaseRef`; plain folders (`vcs: "none"`) run tasks in
// place — the directory itself is every task's cwd, with no branch isolation.
export interface Repo {
  id: string;
  name: string;
  path: string;
  vcs: "git" | "none";
  defaultBaseRef: string; // branch/commit-ish new task worktrees fork from ("" when vcs is "none")
  createdAt: number;
}

// How a routine's cadence is expressed. The friendly presets compile to a 5-field
// cron `schedule` server-side; "manual" never auto-fires (run-now only, so its
// schedule is empty); "custom" carries a raw cron the user typed.
export type RoutinePreset = "hourly" | "daily" | "weekly" | "weekdays" | "manual" | "custom";

// A scheduled, recurring dispatch. Every fire creates a fresh
// task from this template; `schedule` is a standard 5-field cron expression
// (empty for a "manual" routine, which only fires via run-now).
export interface Routine {
  id: string;
  repoId: string;
  agent: AgentKind;
  title?: string;
  prompt: string;
  permission: Permission;
  model?: string;
  effort?: string; // reasoning effort (claude --effort / codex model_reasoning_effort)
  preset: RoutinePreset; // how the cadence was chosen; "custom" = raw cron
  schedule: string; // "m h dom mon dow" — compiled from preset; "" when manual
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt: number;
  updatedAt: number;
}

// One recorded execution of a routine. A scheduled fire and a
// run-now each create one; a run missed while the server was down is logged as
// "skipped" (we do not catch up). `taskId` is the task the fire created.
export interface RoutineRun {
  id: number;
  routineId: string;
  firedAt: number;
  status: "fired" | "manual" | "skipped";
  taskId?: string; // absent for "skipped" (or a fire that failed before dispatch)
  note?: string; // error detail when a fire failed
}

// A GitHub pull request the agent opened during this task. In full-auto the
// agents open their own PRs, so we surface every PR URL that shows up in the
// task's event stream (a single task/session can open several). `status`/`checks`
// start at their "unknown-ish" defaults (open/unknown) and are filled in by the
// server's GitHub status fetch — which is fail-soft: with no token or an
// unreachable API the PR stays a plain link at the defaults. See github.ts.
export type PrLifecycle = "open" | "draft" | "merged" | "closed";
export type PrChecks = "passed" | "pending" | "failed" | "none" | "unknown";

export interface PrRef {
  url: string; // canonical https://github.com/<owner>/<repo>/pull/<n>
  number: number; // <n>
  repo: string; // "<owner>/<repo>", parsed from the URL
  title?: string; // PR title (from the GitHub API; absent until fetched)
  status: PrLifecycle; // lifecycle; "open" until the API says otherwise
  checks: PrChecks; // CI rollup for the head commit; "unknown" until fetched
  branch?: string; // head ref (from the API)
  fetchedAt?: number; // last successful GitHub status fetch (ms epoch); absent = never
}

// Parse a canonical GitHub PR URL into "<owner>/<repo>" + number (null if it
// isn't one). Shared by detection (service.ts) and the legacy pr_url migration
// (db.ts) so both build PrRefs the same way.
const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
export function parsePrUrl(url: string): { repo: string; number: number } | null {
  const m = PR_URL_RE.exec(url);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

// Build a fresh PrRef from a raw URL at its pre-fetch defaults (open / unknown).
// Returns null when the URL isn't a recognizable PR URL.
export function makePrRef(url: string): PrRef | null {
  const p = parsePrUrl(url);
  return p ? { url, number: p.number, repo: p.repo, status: "open", checks: "unknown" } : null;
}

// The durable unit of work. A task outlives any single process: a child exists
// only while a turn runs; between turns the task sits `idle` and resumes by
// `sessionId` off the CLI's local transcript (no external session store).
export interface TaskState {
  taskId: string;
  repoId: string;
  agent: AgentKind;
  title?: string;
  prompt: string; // the initial dispatch prompt
  status: TaskStatus;
  interrupted: boolean; // true once a turn was cut short (e.g. restart recovery)
  sessionId?: string; // claude session_id | codex thread_id
  branch?: string; // agent/<taskId>
  worktreePath?: string; // the stable cwd for the task's whole life
  prs?: PrRef[]; // every GitHub PR opened in this task's event stream, in first-seen order
  prUrl?: string; // back-compat: the first PR's URL (= prs[0]?.url); kept for the push body + older clients
  pendingInput?: QuestionRequest; // set while awaiting_input — the unanswered AskUserQuestion (cleared on answer/settle)
  permission: Permission;
  model?: string;
  effort?: string; // reasoning effort (claude --effort / codex model_reasoning_effort)
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
}
