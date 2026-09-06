import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type {
  AgentKind, AgentUsage, AnswerRequest, CreateRepoRequest, CreateTaskRequest, ImageAttachment, PrRef, QuestionRequest, Repo, SteerResponse, TaskState, TaskStatus,
} from "@palmagent/shared";
import { DEFAULT_PERMISSION, makePrRef } from "@palmagent/shared";
import { config } from "./config.js";
import type { Db } from "./db.js";
import type { GithubService } from "./github.js";
import type { Hub } from "./hub.js";
import type { PushService } from "./push.js";
import { getRunner } from "./runner.js";
import type { ProcessSupervisor } from "./supervisor.js";
import type { RawEvent, RunHandle, RunnerBackend } from "./types.js";
import { expandHome } from "./paths.js";
import { detectDefaultBranch, gitToplevel, WorktreeManager } from "./worktree.js";

// Lets handlers translate failures into HTTP status codes.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const badRequest = (m: string) => new HttpError(400, m);
const notFound = (m: string) => new HttpError(404, m);
const conflict = (m: string) => new HttpError(409, m);

interface TurnState {
  sawResult: boolean; // a terminal result event arrived (claude result / codex turn.completed)
  lastResultError: boolean; // is_error of the LAST result (so an interrupt's aborted result is superseded)
  errored: boolean; // a non-result error event arrived (used only when no result ever did)
  abnormalExit?: boolean; // signal, spawn failure, or lost backend connection
}

// The state machine + persistence + lifecycle glue. Everything agent-specific
// stays behind getRunner() — this file never branches on agent kind.
export class TaskService {
  private cache = new Map<string, TaskState>(); // live mirror of the tasks table
  private turnState = new Map<string, TurnState>(); // per-active-turn error tracking
  private pendingSteer = new Map<string, { text: string; images: ImageAttachment[] }[]>(); // codex steer → next-turn queue
  private stopping = new Set<string>(); // user-requested stop → settle idle(interrupted), not failed
  private steerRestart = new Set<string>(); // steer changed model/effort → interrupt was deliberate, not a failure
  // Per-active-turn reattach baseline: stdout line seqs <= this were already
  // persisted in a prior web-server life, so on replay they update in-memory
  // state but are NOT re-persisted/re-broadcast (exactly-once).
  private turnBaseline = new Map<string, number>();
  // Optional GitHub PR-status fetcher (github.ts), attached after construction
  // (it takes `this` as its sink). Absent when PR integration is not configured.
  private github?: GithubService;

  constructor(
    private readonly db: Db,
    private readonly hub: Hub,
    private readonly supervisor: ProcessSupervisor,
    private readonly backend: RunnerBackend,
    private readonly worktrees: WorktreeManager,
    private readonly push?: PushService,
  ) {}

  // Hydrate from DB and run restart recovery. Turns still alive in the runner
  // daemon are REATTACHED (they survived the deploy); the rest are reset to
  // idle(interrupted) so they can be resumed off the transcript. With the
  // in-process backend nothing is ever live → every in-flight task resets,
  // exactly the pre-daemon behavior.
  async init(): Promise<void> {
    for (const t of this.db.listTasks()) this.cache.set(t.taskId, t);

    const inFlight = new Set(this.db.inFlightTaskIds());
    let live: string[] = [];
    if (inFlight.size) {
      try {
        live = (await this.backend.listLive()).filter((id) => inFlight.has(id));
      } catch {
        live = [];
      }
    }
    const reattached: string[] = [];
    for (const id of live) {
      const t = this.cache.get(id);
      // Only resume-capable turns (running/awaiting) reattach; a queued task
      // never captured a session, so let it fall through to reset.
      if (t && (t.status === "running" || t.status === "awaiting_approval" || t.status === "awaiting_input")) {
        try {
          this.reattachTurn(t);
          reattached.push(id);
        } catch {
          /* fall through to reset below */
        }
      }
    }

    const keep = new Set(reattached);
    const recovered = this.db.recoverInFlight(Date.now(), keep);
    for (const id of recovered) {
      const t = this.cache.get(id);
      if (t) {
        t.status = "idle";
        t.interrupted = true;
      }
    }
    if (reattached.length) {
      console.log(`[recovery] reattached ${reattached.length} live turn(s) from the runner daemon`);
    }
    if (recovered.length) {
      console.log(`[recovery] reset ${recovered.length} in-flight task(s) to idle(interrupted)`);
    }
    this.broadcastTasks();
  }

  // ---- repos ----
  createRepo(req: CreateRepoRequest): Repo {
    if (!req?.path) throw badRequest("path is required");
    const requested = resolve(expandHome(String(req.path).trim()));
    const root = gitToplevel(requested);
    if (!root && !isDirectory(requested)) {
      throw badRequest(
        existsSync(requested) ? `not a directory: ${requested}` : `no such directory: ${requested}`,
      );
    }
    // Git paths snap to the work-tree root (registering /repo/sub must not
    // scatter hidden worktree directories inside subdirectories); a plain directory with no
    // git registers as-is (vcs "none" — tasks run in place, no worktree).
    // Dedupe by path — re-adding returns the existing entry.
    const path = root ?? requested;
    const existing = this.db.listRepos().find((r) => r.path === path);
    if (existing) return existing;
    const repo: Repo = {
      id: genId("r"),
      name: req.name || basename(path),
      path,
      vcs: root ? "git" : "none",
      defaultBaseRef: root ? req.defaultBaseRef || detectDefaultBranch(root) : "",
      createdAt: Date.now(),
    };
    this.db.insertRepo(repo);
    return repo;
  }
  deleteRepo(id: string): Repo {
    const repo = this.getRepo(id);
    const live = [...this.cache.values()].filter((t) => t.repoId === id && t.status !== "archived");
    if (live.length) throw conflict(`repo has ${live.length} non-archived task(s) — archive them first`);
    this.db.deleteRepo(id);
    // deleteRepo cascades to the repo's (archived) tasks in the DB; drop them
    // from the in-memory cache too so listTasks doesn't resurrect dead rows.
    for (const t of [...this.cache.values()]) {
      if (t.repoId === id) this.cache.delete(t.taskId);
    }
    return repo;
  }
  listRepos(): Repo[] {
    return this.db.listRepos();
  }
  getRepo(id: string): Repo {
    const r = this.db.getRepo(id);
    if (!r) throw notFound(`no such repo: ${id}`);
    return r;
  }

  // ---- tasks (read) ----
  listTasks(status?: TaskStatus): TaskState[] {
    const all = [...this.cache.values()].sort((a, b) => a.createdAt - b.createdAt);
    return status ? all.filter((t) => t.status === status) : all;
  }
  getTask(id: string): TaskState {
    const t = this.cache.get(id);
    if (!t) throw notFound(`no such task: ${id}`);
    return t;
  }

  // ---- GitHub PR status (github.ts implements the fetch; we are its sink) ----
  attachGithub(gh: GithubService): void {
    this.github = gh;
  }
  // Tasks the refresher may still want to poll: at least one PR, and not retired
  // (archived/cancelled PRs are frozen). Returns the live PrRef arrays by reference
  // — github.ts only reads them, then hands patches back via applyPrStatuses.
  tasksWithPrs(): { taskId: string; prs: PrRef[] }[] {
    const out: { taskId: string; prs: PrRef[] }[] = [];
    for (const t of this.cache.values()) {
      if (t.prs?.length && t.status !== "archived" && t.status !== "cancelled") {
        out.push({ taskId: t.taskId, prs: t.prs });
      }
    }
    return out;
  }
  // Merge fetched status (keyed by PR url) onto a task's PRs; persist + broadcast
  // only when something actually changed. Unknown urls are ignored (the list may
  // have shifted between fetch and apply).
  applyPrStatuses(taskId: string, patches: Map<string, Partial<PrRef>>): void {
    const task = this.cache.get(taskId);
    if (!task?.prs?.length) return;
    let changed = false;
    task.prs = task.prs.map((pr) => {
      const patch = patches.get(pr.url);
      if (!patch) return pr;
      const next = { ...pr, ...patch };
      // Ignore fetchedAt-only churn so an unchanged poll doesn't re-broadcast.
      if (next.status !== pr.status || next.checks !== pr.checks || next.title !== pr.title || next.branch !== pr.branch) {
        changed = true;
      }
      return next;
    });
    if (!changed) return;
    task.prUrl = task.prs[0]?.url;
    task.updatedAt = Date.now();
    this.db.setTaskPrs(taskId, task.prs, task.updatedAt);
    this.broadcastTasks();
  }

  // ---- usage ----
  // Per-agent aggregate over the result event log (cost/tokens/turns). The DB
  // owns the SQL + payload folding; this stays a thin agent-agnostic pass-through.
  usage(): AgentUsage[] {
    return this.db.usageByAgent();
  }

  // ---- task lifecycle ----
  createTask(req: CreateTaskRequest): TaskState {
    if (req?.agent !== "claude" && req?.agent !== "codex") throw badRequest("agent must be 'claude' or 'codex'");
    if (!req.prompt) throw badRequest("prompt is required");
    const images = sanitizeImages(req.images);
    const repo = this.db.getRepo(req.repoId);
    if (!repo) throw badRequest(`no such repo: ${req.repoId}`);

    const taskId = genId("t");
    const now = Date.now();
    // Worktree isolation is opt-in (req.isolate): a git task that asks for it
    // gets its own worktree+branch — created first, so a failure aborts the task
    // (caller gets 500). Otherwise (the default, and always for plain folders /
    // vcs "none") the task runs in place: the registered directory is its stable
    // cwd and there is no branch.
    const wt =
      req.isolate && repo.vcs !== "none" ? this.worktrees.create(repo, taskId) : undefined;
    const task: TaskState = {
      taskId,
      repoId: repo.id,
      agent: req.agent,
      title: req.title,
      prompt: req.prompt,
      status: "queued",
      interrupted: false,
      branch: wt?.branch,
      worktreePath: wt?.path ?? repo.path,
      permission: req.permission ?? defaultPermission(req.agent),
      model: req.model ?? defaultModel(req.agent),
      effort: req.effort ?? defaultEffort(req.agent),
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    };
    this.db.insertTask(task);
    this.cache.set(taskId, task);
    this.broadcastTasks();
    // Emit the dispatch prompt into the event log (like followup/steer) so the
    // task view renders it from the live stream, not just the inbox snapshot —
    // otherwise opening a fresh task before its snapshot lands shows no prompt.
    const nImages = images?.length ?? 0;
    this.emitSynthetic(task, { subtype: "dispatch", text: req.prompt, images: nImages || undefined });
    void this.runTurn(task, req.prompt, undefined, images); // new session
    return task;
  }

  followup(id: string, prompt: string, rawImages?: unknown, model?: string, effort?: string, permission?: string): TaskState {
    const task = this.getTask(id);
    if (!prompt) throw badRequest("prompt is required");
    const images = sanitizeImages(rawImages);
    if (this.supervisor.has(id)) throw conflict("a turn is already active");
    if (task.status !== "idle" && task.status !== "failed") {
      throw conflict(`cannot follow up a ${task.status} task`);
    }
    this.applySettings(task, model, effort, permission); // resumes with the new model/effort/permission if changed
    const nImages = images?.length ?? 0;
    this.emitSynthetic(task, { subtype: "followup", text: prompt, images: nImages || undefined });
    void this.runTurn(task, prompt, task.sessionId, images); // resume by id off the local transcript
    return task;
  }

  steer(id: string, text: string, rawImages?: unknown, model?: string, effort?: string, permission?: string): SteerResponse {
    const task = this.getTask(id);
    if (!text) throw badRequest("text is required");
    const images = sanitizeImages(rawImages);
    const nImages = images?.length ?? 0;
    // Persist any model/effort/permission override up front — every turn reads it off the task.
    const settingsChanged = this.applySettings(task, model, effort, permission);
    const handle = this.supervisor.get(id);
    if (handle) {
      // A running process can't adopt new flags, so a changed model/effort must
      // run as a fresh resumed turn rather than a mid-turn injection.
      if (settingsChanged) {
        const q = this.pendingSteer.get(id) ?? [];
        q.push({ text, images: images ?? [] });
        this.pendingSteer.set(id, q);
        // Claude can interrupt now so the new settings take effect immediately;
        // Codex can't, so the queued steer chains when the current turn ends.
        this.steerRestart.add(id);
        const restarted = handle.interrupt();
        if (!restarted) this.steerRestart.delete(id);
        this.emitSynthetic(task, {
          subtype: "steer", injected: false, queued: true, restarted, text,
          model: task.model, effort: task.effort, permission: task.permission, images: nImages || undefined,
        });
        return { injected: false, queued: true, restarted };
      }
      // Claude: control_request interrupt (true). Codex: no channel (false).
      if (handle.steer(text, images)) {
        this.emitSynthetic(task, { subtype: "steer", injected: true, text, images: nImages || undefined });
        return { injected: true, queued: false };
      }
      const q = this.pendingSteer.get(id) ?? [];
      q.push({ text, images: images ?? [] });
      this.pendingSteer.set(id, q);
      this.emitSynthetic(task, { subtype: "steer", injected: false, queued: true, text, images: nImages || undefined });
      return { injected: false, queued: true };
    }
    // No active turn: run the steer as an immediate follow-up if resumable.
    if (task.status === "idle" || task.status === "failed") {
      void this.runTurn(task, text, task.sessionId, images);
      this.emitSynthetic(task, { subtype: "steer", injected: false, queued: false, text, images: nImages || undefined, note: "ran as follow-up" });
      return { injected: false, queued: false };
    }
    this.emitSynthetic(task, { subtype: "steer", injected: false, queued: false, text, note: `ignored in ${task.status}` });
    return { injected: false, queued: false };
  }

  approve(id: string, decision: string, scope?: string): TaskState {
    const task = this.getTask(id);
    const now = Date.now();
    this.db.insertApproval(id, null, scope ? JSON.stringify({ scope }) : null, decision, now);
    this.supervisor.get(id)?.approve(decision, scope);
    if (task.status === "awaiting_approval") this.transition(task, "running");
    this.emitSynthetic(task, { subtype: "approval", decision, scope });
    return task;
  }

  // Answer a pending AskUserQuestion: hand the picks to the live turn (which
  // writes the control_response that unblocks the CLI), record the answer as a
  // synthetic event (shown as a "You" bubble), clear the pending question, and
  // resume `running`. 409 if the task isn't actually paused on a question.
  answer(id: string, req: AnswerRequest): TaskState {
    const task = this.getTask(id);
    if (task.status !== "awaiting_input") throw conflict(`task is not awaiting input (${task.status})`);
    if (!req?.requestId) throw badRequest("requestId is required");
    const handle = this.supervisor.get(id);
    if (!handle?.answer(req)) throw conflict("no matching pending question to answer");
    const now = Date.now();
    task.pendingInput = undefined;
    this.db.setTaskPendingInput(task.taskId, undefined, now);
    this.emitSynthetic(task, { subtype: "answer", answers: req.answers, response: req.response });
    this.transition(task, "running");
    return task;
  }

  // Stop = interrupt the current turn but keep the task resumable. Unlike
  // cancel, the worktree and session survive: the task settles
  // idle(interrupted=true) and a follow-up resumes off the CLI transcript.
  stop(id: string): TaskState {
    const task = this.getTask(id);
    if (task.status === "cancelled" || task.status === "archived") {
      throw conflict(`cannot stop a ${task.status} task`);
    }
    const handle = this.supervisor.get(id);
    if (handle) {
      this.pendingSteer.delete(id); // stop wins over a queued codex steer
      this.stopping.add(id);
      this.emitSynthetic(task, { subtype: "stop", note: "turn interrupt requested" });
      // Claude: graceful control_request interrupt. Codex: no channel → SIGINT
      // (rollouts persist incrementally, so SIGINT-then-resume works).
      if (!handle.interrupt()) handle.cancel();
      return task; // settles via finishTurn when the child exits
    }
    if (task.status === "queued") {
      // Never started — leave the queue (runTurn's post-acquire check bails).
      // Like crash-while-queued, the un-run prompt is not auto-executed later.
      this.transition(task, "idle", { interrupted: true });
      this.emitSynthetic(task, { subtype: "stop", note: "dequeued before start" });
    }
    return task; // idle/failed: nothing to stop (idempotent)
  }

  cancel(id: string): TaskState {
    const task = this.getTask(id);
    if (task.status === "cancelled" || task.status === "archived") return task; // idempotent
    this.pendingSteer.delete(id);
    const handle = this.supervisor.get(id);
    this.transition(task, "cancelled");
    if (handle) {
      handle.cancel(); // SIGINT; finishTurn() removes the worktree once it exits
    } else {
      this.cleanupWorktree(task); // no process held — clean up now
    }
    return task;
  }

  archive(id: string): TaskState {
    const task = this.getTask(id);
    if (task.status === "archived") return task; // idempotent
    if (this.supervisor.has(id)) throw conflict("cancel the active turn before archiving");
    this.transition(task, "archived");
    this.cleanupWorktree(task);
    return task;
  }

  // ---- turn execution ----
  private async runTurn(task: TaskState, prompt: string, resumeId?: string, images?: ImageAttachment[]): Promise<void> {
    if (!this.supervisor.tryAcquire()) {
      this.transition(task, "queued"); // over the concurrency cap — wait for a slot
      await this.supervisor.acquire();
      // The wait is the only interleave point: bail if the task was cancelled,
      // archived, or stopped (→ idle) while queued.
      if (task.status !== "queued") {
        this.supervisor.release(task.taskId);
        return;
      }
    }
    this.startTurnNow(task, prompt, resumeId, images);
  }

  private startTurnNow(task: TaskState, prompt: string, resumeId?: string, images?: ImageAttachment[]): void {
    const runner = getRunner(task.agent);
    this.turnState.set(task.taskId, { sawResult: false, lastResultError: false, errored: false });
    // A brand-new turn starts a fresh stdout stream: baseline 0, nothing replayed.
    this.turnBaseline.set(task.taskId, 0);
    this.db.setTaskRawSeq(task.taskId, 0);
    this.transition(task, "running", { interrupted: false });
    let handle: RunHandle;
    try {
      handle = runner.start(
        {
          taskId: task.taskId,
          cwd: task.worktreePath!, // stable for the task's whole life
          prompt,
          images,
          resumeId,
          permission: task.permission,
          model: task.model,
          effort: task.effort,
        },
        (raw, rawSeq) => this.onRaw(task, raw, rawSeq),
        this.backend,
      );
    } catch (e) {
      // A synchronous spawn failure must release the slot, not leak it / wedge the task.
      this.turnState.delete(task.taskId);
      this.supervisor.release(task.taskId);
      this.emitSynthetic(task, { subtype: "error", message: `failed to start turn: ${String(e)}` });
      this.transition(task, "failed");
      return;
    }
    this.supervisor.register(task.taskId, handle);
    handle.done.then(() => this.finishTurn(task), () => this.finishTurn(task));
  }

  // Restart recovery: rebuild a RunHandle for a turn STILL RUNNING in the daemon.
  // The adapter reattaches (replays the buffered stream, does not re-send the
  // prompt); the service replays through onRaw but suppresses already-persisted
  // events via the baseline. The turn keeps its slot (reclaim) and stays running.
  private reattachTurn(task: TaskState): void {
    const runner = getRunner(task.agent);
    this.turnState.set(task.taskId, { sawResult: false, lastResultError: false, errored: false });
    const baseline = this.db.getTaskRawSeq(task.taskId);
    this.turnBaseline.set(task.taskId, baseline);
    const handle = runner.start(
      {
        taskId: task.taskId,
        cwd: task.worktreePath!,
        prompt: "", // unused on reattach — the live turn already got its prompt
        resumeId: task.sessionId,
        permission: task.permission,
        model: task.model,
        effort: task.effort,
        reattach: true,
        resumeFromSeq: baseline,
        // If the turn is paused on AskUserQuestion, hand the adapter the persisted
        // question so historical control requests can be skipped during replay.
        pendingInput: task.pendingInput,
      },
      (raw, rawSeq) => this.onRaw(task, raw, rawSeq),
      this.backend,
    );
    this.supervisor.reclaim(task.taskId, handle);
    handle.done.then(() => this.finishTurn(task), () => this.finishTurn(task));
  }

  // `rawSeq` is the source stdout line's per-turn sequence (undefined for stderr/
  // synthetic events). In-memory bookkeeping (session/turnState/approval/PR) runs
  // for EVERY event so reattach rebuilds state from the replayed stream; only the
  // DB insert + SSE fan-out are suppressed for events at or below the reattach
  // baseline (already persisted in a prior life).
  private onRaw(task: TaskState, raw: RawEvent, rawSeq?: number): void {
    const now = Date.now();
    const event = { ...raw, agent: task.agent, ts: now };

    if (event.sessionId && task.sessionId !== event.sessionId) {
      task.sessionId = event.sessionId; // capture claude session_id / codex thread_id
      this.db.setTaskSession(task.taskId, event.sessionId, now);
      this.broadcastTasks();
    }

    const ts = this.turnState.get(task.taskId);
    if (ts) {
      if (event.kind === "error") ts.errored = true;
      if (event.kind === "result") {
        ts.sawResult = true;
        ts.lastResultError = !!(event.payload as { is_error?: boolean })?.is_error;
      }
      if (event.kind === "status") {
        const status = event.payload as { subtype?: string; code?: number | null };
        if (status.subtype === "process_exit") ts.abnormalExit = status.code !== 0;
        if (status.subtype === "reattach_failed") ts.abnormalExit = true;
      }
    }
    // Rebuild terminal bookkeeping above, but never repeat persisted effects
    // such as questions, notifications, event inserts, or SSE broadcasts.
    if (rawSeq !== undefined && rawSeq <= (this.turnBaseline.get(task.taskId) ?? 0)) return;

    if (event.kind === "approval_request" && task.status === "running") {
      this.transition(task, "awaiting_approval");
      this.notifyPush(task, "needs approval", "The agent is waiting for your decision.");
    }
    // AskUserQuestion (Claude): the turn is paused waiting for the user to answer.
    // Stash the question on the task (mem + DB) so the inbox/detail can render the
    // tap-to-answer UI, and notify the phone. The handle.answer() resumes the turn.
    if (event.kind === "question") {
      const qr = event.payload as QuestionRequest;
      task.pendingInput = qr;
      this.db.setTaskPendingInput(task.taskId, qr, now);
      if (task.status === "running") {
        this.transition(task, "awaiting_input");
        this.notifyPush(task, "needs your input", firstQuestionText(qr));
      } else {
        this.broadcastTasks();
      }
    }

    // Full-auto: the agent opens its own PRs. Collect every distinct PR URL that
    // shows up anywhere in this task's stream (a session can open several) so the
    // inbox can surface them all. New PRs start at their pre-fetch defaults
    // (open/unknown); github.ts fills in lifecycle + checks out of band.
    if (PR_EVENT_KINDS.has(event.kind)) {
      const fresh = findPrUrls(event.payload).filter((u) => !task.prs?.some((p) => p.url === u));
      const refs = fresh.map(makePrRef).filter((r): r is PrRef => r !== null);
      if (refs.length) {
        task.prs = [...(task.prs ?? []), ...refs];
        task.prUrl = task.prs[0]?.url;
        task.updatedAt = now;
        this.db.setTaskPrs(task.taskId, task.prs, now);
        this.broadcastTasks();
        this.github?.onNewPrs(task.taskId); // fetch lifecycle/checks promptly
      }
    }

    // Persist every emitted event (this IS the event log) then fan out to SSE.
    const { id, seq } = this.db.insertEvent(task.taskId, event.kind, event.payload, now);
    // Advance the reattach high-water-mark so a future restart resumes past here.
    if (rawSeq !== undefined) this.db.setTaskRawSeq(task.taskId, rawSeq);
    this.db.touchTask(task.taskId, now);
    task.lastActivityAt = now;
    this.hub.emitEvent({ id, seq, event });
  }

  private finishTurn(task: TaskState): void {
    this.supervisor.release(task.taskId);
    // The turn's process has exited — tell the daemon to drop its replay buffer
    // (no-op for the in-process backend) and forget this turn's reattach baseline.
    this.backend.release?.(task.taskId);
    this.turnBaseline.delete(task.taskId);
    const ts = this.turnState.get(task.taskId);
    this.turnState.delete(task.taskId);
    const stopped = this.stopping.delete(task.taskId);
    // The turn is over — no question can be pending anymore (e.g. Stop while
    // awaiting_input, or the CLI declined). Clear it so the UI drops the answer form.
    if (task.pendingInput) {
      task.pendingInput = undefined;
      this.db.setTaskPendingInput(task.taskId, undefined, Date.now());
    }
    // A steer that changed model/effort interrupted this turn on purpose so the
    // queued steer can resume with the new flags — its aborted result is not a
    // real failure (which would suppress the chain below).
    const steerRestart = this.steerRestart.delete(task.taskId);

    if (task.status === "cancelled") {
      this.cleanupWorktree(task);
      this.broadcastTasks();
      return;
    }
    if (stopped) {
      // User-requested stop: always resumable, never failed (the interrupt's
      // aborted result / SIGINT exit must not count as an error). No steer
      // chaining, no push — the user did this themselves.
      this.transition(task, "idle", { interrupted: true });
      return;
    }
    // Decide off the TERMINAL signal: if a result arrived, trust its is_error
    // (Codex success = turn.completed with no is_error; a transient mid-turn
    // error item does NOT fail the turn). Only fall back to `errored` (e.g.
    // codex turn.failed, which has no result) when no result ever arrived.
    // A signal, lost backend, or failed spawn is never a normal completion.
    const failed = !steerRestart && !!ts &&
      (ts.abnormalExit || (ts.sawResult ? ts.lastResultError : ts.errored));
    this.transition(task, failed ? "failed" : "idle");

    // Codex steer fallback: text queued mid-turn runs now as the next turn.
    const pending = this.pendingSteer.get(task.taskId);
    const chains = !failed && !!pending && pending.length > 0;
    if (chains && pending) {
      this.pendingSteer.delete(task.taskId);
      void this.runTurn(
        task,
        pending.map((p) => p.text).join("\n"),
        task.sessionId,
        pending.flatMap((p) => p.images),
      );
    }
    // Notify the phone only when the task actually settles (not when a queued
    // steer immediately chains into the next turn).
    if (!chains) {
      this.notifyPush(
        task,
        failed ? "failed" : "finished",
        failed ? "The turn errored — open to inspect." : task.prUrl ? `Done. PR: ${task.prUrl}` : "Turn finished — task is idle.",
      );
    }
  }

  // ---- helpers ----
  // Apply a model / effort / permission override onto the task (persisted; every
  // turn reads them off the task). Per field: undefined = leave as-is, "" = reset
  // to the agent's default (clear the override), any other value = set it.
  // Returns whether anything actually changed.
  private applySettings(task: TaskState, model?: string, effort?: string, permission?: string): boolean {
    const nextModel = model === undefined ? task.model : model === "" ? defaultModel(task.agent) : model;
    const nextEffort = effort === undefined ? task.effort : effort === "" ? defaultEffort(task.agent) : effort;
    const nextPermission =
      permission === undefined ? task.permission : permission === "" ? defaultPermission(task.agent) : permission;
    if (nextModel === task.model && nextEffort === task.effort && nextPermission === task.permission) return false;
    task.model = nextModel;
    task.effort = nextEffort;
    task.permission = nextPermission;
    const now = Date.now();
    task.updatedAt = now;
    this.db.setTaskSettings(task.taskId, task.model, task.effort, task.permission, now);
    this.broadcastTasks();
    return true;
  }

  private transition(task: TaskState, status: TaskStatus, opts?: { interrupted?: boolean }): void {
    const now = Date.now();
    task.status = status;
    if (opts?.interrupted !== undefined) task.interrupted = opts.interrupted;
    task.updatedAt = now;
    this.db.setTaskStatus(task.taskId, status, task.interrupted, now);
    this.broadcastTasks();
  }

  private emitSynthetic(task: TaskState, payload: unknown): void {
    const now = Date.now();
    const { id, seq } = this.db.insertEvent(task.taskId, "status", payload, now);
    this.db.touchTask(task.taskId, now);
    this.hub.emitEvent({
      id,
      seq,
      event: { taskId: task.taskId, agent: task.agent, kind: "status", sessionId: task.sessionId, payload, ts: now },
    });
  }

  private cleanupWorktree(task: TaskState): void {
    // No branch = plain-folder task: its cwd is the registered directory
    // itself — never remove it.
    if (!task.worktreePath || !task.branch) return;
    const repo = this.db.getRepo(task.repoId);
    if (repo) this.worktrees.remove(repo, { branch: task.branch, path: task.worktreePath });
  }

  private broadcastTasks(): void {
    this.hub.emitTasks(this.listTasks());
  }

  private notifyPush(task: TaskState, what: string, body: string): void {
    const title = `${task.agent} ${what}: ${headline(task)}`;
    this.push?.notify({ title, body, taskId: task.taskId, url: `/#/task/${task.taskId}` });
  }
}

// ---- image attachments ----
// Claude's API caps images at 5MB; cap a bit under it (decoded) and keep the
// count sane. The PWA downscales before upload, so these are backstops.
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function sanitizeImages(raw: unknown): ImageAttachment[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw badRequest("images must be an array");
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_IMAGES) throw badRequest(`too many images (max ${MAX_IMAGES})`);
  return raw.map((img, i) => {
    const mediaType = String((img as { mediaType?: unknown })?.mediaType ?? "");
    let data = String((img as { data?: unknown })?.data ?? "");
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) throw badRequest(`images[${i}]: unsupported mediaType '${mediaType}'`);
    data = data.replace(/^data:[^,]*,/, ""); // be lenient about data: URL prefixes
    if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) throw badRequest(`images[${i}]: data must be base64`);
    data = data.replace(/\s+/g, "");
    if (data.length * 0.75 > MAX_IMAGE_BYTES) {
      throw badRequest(`images[${i}]: too large (max ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB decoded)`);
    }
    return { mediaType, data };
  });
}

// Event kinds that can plausibly carry a PR URL the agent printed/created.
const PR_EVENT_KINDS = new Set(["assistant_text", "tool_result", "tool_call", "result"]);
const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

// Every distinct PR URL anywhere in a (stringified) event payload, first-seen order.
function findPrUrls(payload: unknown): string[] {
  try {
    const seen = new Set<string>();
    for (const m of JSON.stringify(payload).matchAll(PR_URL_RE)) seen.add(m[0]);
    return [...seen];
  } catch {
    return [];
  }
}

// A short push-body for an AskUserQuestion: the first question's text (or count).
function firstQuestionText(qr: QuestionRequest): string {
  const first = qr.questions?.[0]?.question?.trim();
  const extra = (qr.questions?.length ?? 0) > 1 ? ` (+${qr.questions.length - 1} more)` : "";
  const base = first || "The agent is asking you a question.";
  return (base.length > 80 ? base.slice(0, 77) + "…" : base) + extra;
}

function headline(task: TaskState): string {
  const t = task.title?.trim() || task.prompt.split("\n").find((l) => l.trim())?.trim() || task.taskId;
  return t.length > 60 ? t.slice(0, 57) + "…" : t;
}

function defaultModel(agent: AgentKind): string | undefined {
  return agent === "claude" ? config.claudeModel : config.codexModel;
}

function defaultEffort(agent: AgentKind): string | undefined {
  return agent === "claude" ? config.claudeEffort : config.codexEffort;
}

function defaultPermission(agent: AgentKind): string {
  return DEFAULT_PERMISSION[agent];
}

function genId(prefix: string): string {
  return prefix + randomBytes(4).toString("hex");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
