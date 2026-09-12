import { execFile } from "node:child_process";
import { BRANDING } from "@palmagent/shared";
import type { PrChecks, PrLifecycle, PrRef } from "@palmagent/shared";

// GitHub PR status, fetched out of band and merged back onto tasks. This is the
// ONLY outbound network the web server makes; it is entirely fail-soft — with no
// token or an unreachable API the PRs simply stay plain links at their pre-fetch
// defaults (open/unknown). Nothing here can throw into the task loop.
//
// The sink decouples us from TaskService: it implements these two methods (and
// passes itself to the constructor), so github.ts never imports the service.
export interface PrStatusSink {
  // Tasks with at least one PR worth refreshing (archived/cancelled excluded —
  // their PRs are frozen). Returns a snapshot copy; we never mutate it.
  tasksWithPrs(): { taskId: string; prs: PrRef[] }[];
  // Merge fetched status (keyed by PR url) onto a task's PRs; persist + broadcast.
  applyPrStatuses(taskId: string, patches: Map<string, Partial<PrRef>>): void;
}

const REFRESH_MS = 60_000; // how often non-terminal PRs are re-polled
const REQUEST_TIMEOUT_MS = 8_000;
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "stale"]);

// A PR is terminal once merged or closed — its status never changes again, so we
// stop polling it (saves API calls; an old open PR keeps polling until it lands).
const isTerminal = (pr: PrRef): boolean => pr.status === "merged" || pr.status === "closed";

export class GithubService {
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private tokenResolved = false;
  private token: string | null = null;
  private inFlight = new Set<string>(); // taskIds currently being fetched (de-dupe)

  // `explicitToken` is GITHUB_TOKEN (config). When absent we fall back to the
  // host's `gh auth token` once, lazily, on first need.
  constructor(private readonly sink: PrStatusSink, private readonly explicitToken?: string) {}

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.refreshAll(), REFRESH_MS);
    this.timer.unref(); // never hold the process open for a poll
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  // A task just gained new PRs — fetch their status promptly (don't wait for the
  // next tick). Fire-and-forget; failures are swallowed inside refreshTask.
  onNewPrs(taskId: string): void {
    void this.refreshTask(taskId);
  }

  private async refreshAll(): Promise<void> {
    for (const { taskId, prs } of this.sink.tasksWithPrs()) {
      if (prs.some((p) => !isTerminal(p))) void this.refreshTask(taskId);
    }
  }

  private async refreshTask(taskId: string): Promise<void> {
    if (this.stopped || this.inFlight.has(taskId)) return;
    const entry = this.sink.tasksWithPrs().find((t) => t.taskId === taskId);
    if (!entry) return;
    const token = await this.resolveToken();
    if (this.stopped || !token) return; // fail-soft: no token ⇒ leave PRs as plain links
    this.inFlight.add(taskId);
    try {
      const patches = new Map<string, Partial<PrRef>>();
      await Promise.all(
        entry.prs
          .filter((pr) => !isTerminal(pr))
          .map(async (pr) => {
            const patch = await fetchPrStatus(pr, token).catch(() => null);
            if (patch) patches.set(pr.url, patch);
          }),
      );
      if (!this.stopped && patches.size) this.sink.applyPrStatuses(taskId, patches);
    } finally {
      this.inFlight.delete(taskId);
    }
  }

  // Resolve once: GITHUB_TOKEN wins; else `gh auth token`. The null result is
  // cached too (no repeated process spawns) — log in to gh BEFORE boot.
  private async resolveToken(): Promise<string | null> {
    if (this.tokenResolved) return this.token;
    this.tokenResolved = true;
    this.token = this.explicitToken?.trim() || (await ghAuthToken());
    if (!this.token) {
      console.warn(
        "[github] no GITHUB_TOKEN and `gh auth token` unavailable — PR status disabled (links still work)",
      );
    }
    return this.token;
  }
}

// ---- GitHub REST ----

interface GhPull {
  title?: string;
  state?: string; // "open" | "closed"
  draft?: boolean;
  merged?: boolean;
  head?: { ref?: string; sha?: string };
}
interface GhCheckRun {
  status?: string; // "queued" | "in_progress" | "completed"
  conclusion?: string | null; // "success" | "failure" | ...
}

async function fetchPrStatus(pr: PrRef, token: string): Promise<Partial<PrRef>> {
  const base = `https://api.github.com/repos/${pr.repo}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": BRANDING.packageName,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const res = await fetch(`${base}/pulls/${pr.number}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET pulls/${pr.number} → ${res.status}`);
  const j = (await res.json()) as GhPull;
  const status: PrLifecycle = j.merged
    ? "merged"
    : j.state === "closed"
      ? "closed"
      : j.draft
        ? "draft"
        : "open";
  const patch: Partial<PrRef> = { title: j.title, status, branch: j.head?.ref, fetchedAt: Date.now() };
  // Checks only matter while the PR is still live; skip the extra call once terminal.
  if (status === "open" || status === "draft") {
    patch.checks = await fetchChecks(base, j.head?.sha, headers).catch(() => "unknown" as PrChecks);
  }
  return patch;
}

async function fetchChecks(base: string, sha: string | undefined, headers: Record<string, string>): Promise<PrChecks> {
  if (!sha) return "unknown";
  const res = await fetch(`${base}/commits/${sha}/check-runs`, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return "unknown";
  const j = (await res.json()) as { check_runs?: GhCheckRun[] };
  const runs = j.check_runs ?? [];
  if (!runs.length) return "none";
  let pending = false;
  let failed = false;
  for (const r of runs) {
    if (r.status !== "completed") pending = true;
    else if (r.conclusion && FAILED_CONCLUSIONS.has(r.conclusion)) failed = true;
  }
  return failed ? "failed" : pending ? "pending" : "passed";
}

// `gh auth token` → the host's GitHub token (null if gh is absent / logged out).
function ghAuthToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: 5_000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim() || null);
    });
  });
}
