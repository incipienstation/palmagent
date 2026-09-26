import { sanitizeImages } from "./application/image-input.js";
import type { SkillContext, SkillSelection, VoiceClientTimings } from "@palmagent/shared";
import { skillId } from "./application/skill-id.js";
import { MessageController } from "./message-controller.js";
import type { SubmitMessage, MessageAction } from "@palmagent/shared";
import type {
  DispatchSessionRequest, SessionHandoffResponse, AgentKind, AgentUsage, AnswerRequest, CreateRepoRequest, CreateTaskRequest, ImageAttachment, PermissionRequest, PrRef, QuestionRequest, Repo, SteerResponse, TaskState, TaskStatus,
} from "@palmagent/shared";
import { DEFAULT_PERMISSION } from "@palmagent/shared";
import { extractOutputImages } from "./application/output-images.js";
import type {
  AttachmentStorage, PrStatusSink, TaskAccountLimitReader, TaskDefaults, TaskEventPublisher, TaskImageReader,
  IdentifierGenerator, NativeSessionOperations, RepositoryPathOperations, TaskPushNotifier, TaskRepository,
  TaskSkillCatalog, TaskSkillEnvironment, TaskSupervisor, TaskVoiceOperations, TaskWorktreeManager, TerminalTaskLifecycle,
} from "./application/ports.js";
import type { RawEvent, RunHandle, RunnerBackend } from "./types.js";

import { ApplicationError } from "./errors.js";
const badRequest = (m: string) => new ApplicationError("bad_request", m);
const notFound = (m: string) => new ApplicationError("not_found", m);
const conflict = (m: string) => new ApplicationError("conflict", m);

interface TurnState {
  sawResult: boolean; // a terminal result event arrived (claude result / codex turn.completed)
  lastResultError: boolean; // is_error of the LAST result (so an interrupt's aborted result is superseded)
  errored: boolean; // a non-result error event arrived (used only when no result ever did)
  abnormalExit?: boolean; // signal, spawn failure, or lost backend connection
}

// The state machine + persistence + lifecycle glue. Everything agent-specific
// stays behind the injected execution backend — this file never branches on agent kind.
export class TaskService implements PrStatusSink {

  providerHome(agent: AgentKind): string { return this.nativeSession.home(agent); }

  cleanupTerminalWorktree(id: string) {
    const task = this.getTask(id);
    if (["cancelled", "archived"].includes(task.status)) this.cleanupWorktree(task);
  }
  accountLimits(taskId: string) {
    const task = this.getTask(taskId);
    if (!this.accountLimitReader) throw new ApplicationError("service_unavailable", "Account limits are unavailable");
    return this.accountLimitReader.get(task.agent, task.sessionControl?.home ?? this.nativeSession.home(task.agent));
  }

  readAttachment(taskId: string, attachmentId: string) {
    this.getTask(taskId);
    return this.attachments.read(taskId, attachmentId);
  }

  async readTaskImage(taskId: string, requestedPath: string | string[]) {
    const task = this.getTask(taskId);
    if (!this.taskImages) throw new ApplicationError("service_unavailable", "Task image reading is unavailable");
    return this.taskImages.read(task.worktreePath, requestedPath);
  }

  eventCursor(taskId?: string): number { return this.db.eventCursor(taskId); }

  taskHistory(taskId: string, before?: number, includeActivityDetails = true) {
    this.getTask(taskId);
    return before === undefined
      ? this.db.latestHistoryPage(taskId, includeActivityDetails)
      : this.db.historyPage(taskId, before, this.db.eventCursor(taskId), includeActivityDetails);
  }

  taskHistoryChanges(taskId: string, after: number, through?: number, includeActivityDetails = true) {
    this.getTask(taskId);
    if (through !== undefined && through < after) throw badRequest("through must be at least after");
    return this.db.historyChanges(taskId, after, through, includeActivityDetails);
  }

  taskActivityDetails(taskId: string, from: number, through: number) {
    this.getTask(taskId);
    if (from > through) throw badRequest("through must be at least from");
    return this.db.activityDetails(taskId, from, through);
  }

  private shuttingDown = false;
  beginShutdown(): void {
    this.shuttingDown = true;
    this.messages.close();
    this.voice?.close();
    this.attachments.close();
  }

  private cache = new Map<string, TaskState>(); // live mirror of the tasks table
  private sessionMismatch = new Set<string>();
  private turnState = new Map<string, TurnState>(); // per-active-turn error tracking
  private pendingSteer = new Map<string, { text: string; images: ImageAttachment[] }[]>(); // codex steer → next-turn queue
  private stopping = new Set<string>(); // user-requested stop → settle idle(interrupted), not failed
  private steerRestart = new Set<string>(); // steer changed model/effort → interrupt was deliberate, not a failure
  // Per-active-turn reattach baseline: stdout line seqs <= this were already
  // persisted in a prior web-server life, so on replay they update in-memory
  // state but are NOT re-persisted/re-broadcast (exactly-once).
  private turnBaseline = new Map<string, number>();
  readonly messages: MessageController;
  startVoice(context: SkillContext, sdp: string, signal?: AbortSignal) {
    const env = this.skillEnvironment(context);
    if (env.agent !== "codex") throw badRequest("Voice input is available only for Codex.");
    if (this.shuttingDown || this.updating) throw new ApplicationError("service_unavailable", "Voice input is unavailable while restarting.");
    if (!this.voice) throw new ApplicationError("service_unavailable", "Voice input is unavailable");
    return this.voice.start(env.home, sdp, signal);
  }
  touchVoice(id: string): void {
    if (!this.voice) throw new ApplicationError("service_unavailable", "Voice input is unavailable");
    this.voice.touch(id);
  }
  stopVoice(id: string, timings?: VoiceClientTimings): void {
    if (!this.voice) throw new ApplicationError("service_unavailable", "Voice input is unavailable");
    this.voice.stop(id, timings);
  }
  resumeQueue(id: string) { return this.messages.resume(id); }
  private skillEnvironment(context: SkillContext): TaskSkillEnvironment {
    if (context.taskId) {
      const task = this.getTask(context.taskId);
      if (!task.worktreePath) throw conflict("The task working directory is unavailable.");
      return { agent: task.agent, cwd: task.worktreePath, home: task.sessionControl?.home ?? this.nativeSession.home(task.agent) };
    }
    if (!context.repoId || !context.agent) throw badRequest("Select a repository and agent.");
    return { agent: context.agent, cwd: this.getRepo(context.repoId).path, home: this.nativeSession.home(context.agent) };
  }
  async availableSkills(context: SkillContext) {
    const env = this.skillEnvironment(context);
    try {
      if (!this.skillCatalog) throw new Error("Skill discovery is unavailable");
      return await this.skillCatalog.list(env);
    }
    catch (error) { throw new ApplicationError("service_unavailable", error instanceof Error ? error.message : "Skills are unavailable."); }
  }
  async resolveSkills(context: SkillContext, skills?: SkillSelection[]) {
    if (!skills?.length) return undefined;
    const env = this.skillEnvironment(context);
    try {
      if (!this.skillCatalog) throw new Error("Skill selection is unavailable");
      return await this.skillCatalog.resolve(env, skills);
    }
    catch (error) { throw conflict(error instanceof Error ? error.message : "Choose the skill again."); }
  }

  readonly attachments: AttachmentStorage;
  voice?: TaskVoiceOperations;
  skillCatalog?: TaskSkillCatalog;

  constructor(
    private readonly db: TaskRepository,
    private readonly hub: TaskEventPublisher,
    private readonly supervisor: TaskSupervisor,
    private readonly backend: RunnerBackend,
    private readonly worktrees: TaskWorktreeManager,
    attachments: AttachmentStorage,
    private readonly repositoryPaths: RepositoryPathOperations,
    private readonly nativeSession: NativeSessionOperations,
    private readonly ids: IdentifierGenerator,
    private readonly push?: TaskPushNotifier,
    private readonly maintenance: () => boolean = () => false,
    private readonly defaults: TaskDefaults = { model: {}, effort: {} },
    private readonly taskImages?: TaskImageReader,
    private readonly terminalLifecycle?: TerminalTaskLifecycle,
    private readonly requestPrRefresh?: (taskId: string) => void,
    voice?: TaskVoiceOperations,
    skillCatalog?: TaskSkillCatalog,
    private readonly accountLimitReader?: TaskAccountLimitReader,
  ) {
    this.attachments = attachments;
    this.voice = voice;
    this.skillCatalog = skillCatalog;
    this.messages = new MessageController(db, {
      assertWritable: (id) => {
        this.assertTaskAdmission();
        const task = this.getTask(id);
        this.assertSessionOwnership(task);
        if (["cancelled", "archived"].includes(task.status)) throw conflict("This task is closed.");
      },
      canStart: (id) => {
        const task = this.cache.get(id);
        return !this.shuttingDown && !this.updating && !!task
          && (!task.sessionControl || task.sessionControl.owner === "palmagent")
          && ["idle", "failed"].includes(task.status) && !this.supervisor.has(id);
      },
      settings: (id) => {
        const task = this.getTask(id);
        return { model: task.model ?? "", effort: task.effort ?? "", permission: task.permission };
      },
      start: (id, message) => {
        const task = this.getTask(id);
        const images = this.attachments.load(id, message.attachments) ?? message.images;
        this.applySettings(task, message.settings?.model, message.settings?.effort, message.settings?.permission);
        this.emitSynthetic(task, { subtype: "followup", text: message.text, messageId: message.id, images: message.attachments?.length ?? message.images?.length, attachments: message.attachments, skills: message.skills });
        void this.runTurn(task, message.text, task.sessionId, images, message.id, message.skills);
      },
      steer: async (id, message) => {
        const task = this.getTask(id), handle = this.supervisor.get(id);
        if (task.status !== "running" || this.stopping.has(id) || !handle?.send) return "rejected";
        this.emitSynthetic(task, { subtype: "steer", text: message.text, messageId: message.id, images: message.attachments?.length ?? message.images?.length, attachments: message.attachments, skills: message.skills });
        try {
          const skills = await this.resolveSkills({ taskId: id }, message.skills);
          if (this.supervisor.get(id) !== handle || task.status !== "running") return "rejected";
          return handle.send(message.text, this.attachments.load(id, message.attachments) ?? message.images, message.id, skills);
        } catch { return "rejected"; }
      },
      changed: () => this.broadcastTasks(),
    }, attachments);
  }

  async resolveMessageSkills(id: string, req: SubmitMessage) {
    // A retry asks for the existing receipt even if the plugin was removed
    // after delivery. Do not turn an acknowledged send into a new intent.
    this.getTask(id);
    const old = this.db.readMessageState(id)?.messages.find(message => message.id === req.clientMessageId);
    if (old) {
      if (JSON.stringify(old.skills?.map(skill => skill.id) ?? []) !== JSON.stringify(req.skills?.map(skill => skill.id) ?? [])) {
        throw conflict("This message ID was already used with different content.");
      }
      return old.skills;
    }
    return this.resolveSkills({ taskId: id }, req.skills);
  }

  submitMessage(id: string, req: SubmitMessage) { return this.messages.submit(id, { ...req, images: sanitizeImages(req.images) }); }
  messageAction(id: string, messageId: string, req: MessageAction) {
    return this.messages.action(id, messageId, req.action === "save" ? { ...req, images: sanitizeImages(req.images) } : req);
  }

  get executionProtocol(): number | undefined { return this.backend.independent ? 1 : undefined; }

  get updating(): boolean { return this.maintenance(); }

  private assertTaskAdmission(): void {
    if (this.updating || this.shuttingDown) throw new ApplicationError("service_unavailable", "Palmagent is updating. Try starting the task again shortly.");
  }

  // Hydrate from DB and run restart recovery. Turns still alive in the runner
  // daemon are REATTACHED (they survived the deploy); the rest are reset to
  // idle(interrupted) so they can be resumed off the transcript. With the
  // in-process backend nothing is ever live → every in-flight task resets,
  // exactly the pre-daemon behavior.
  async init(): Promise<void> {
    this.attachments.start();
    for (const t of this.db.listTasks()) {
      this.cache.set(t.taskId, t);
      const control = this.backend.loadControl?.(t.taskId);
      if (control?.stopping) this.stopping.add(t.taskId);
      if (control?.steerRestart) this.steerRestart.add(t.taskId);
      if (control?.pendingSteer.length) this.pendingSteer.set(t.taskId, control.pendingSteer);
    }

    const inFlight = new Set(this.db.inFlightTaskIds());
    let live: string[] = [];
    if (inFlight.size || this.backend.independent) {
      try {
        live = (await this.backend.listLive()).filter((id) => inFlight.has(id) || (this.backend.independent && this.cache.get(id)?.status === "cancelled"));
      } catch (error) {
        if (this.backend.independent) throw error;
        live = [];
      }
    }
    if (this.backend.independent && [...inFlight].some(id => !live.includes(id))) {
      throw new Error("An in-flight task has no execution identity; refusing automatic recovery");
    }
    const reattached: string[] = [];
    for (const id of live) {
      const t = this.cache.get(id);
      // Only resume-capable turns (running/awaiting) reattach; a queued task
      // never captured a session, so let it fall through to reset.
      if (t && (t.status === "running" || t.status === "awaiting_approval" || t.status === "awaiting_input" || (this.backend.independent && (t.status === "queued" || t.status === "cancelled")))) {
        try {
          this.reattachTurn(t);
          reattached.push(id);
        } catch (error) {
          if (this.backend.independent) throw error;
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
      console.log(`[recovery] reattached ${reattached.length} live turn(s) from the execution backend`);
    }
    if (recovered.length) {
      console.log(`[recovery] reset ${recovered.length} in-flight task(s) to idle(interrupted)`);
    }
    for (const id of this.db.messageTaskIds()) this.messages.recover(id, keep.has(id));
    this.broadcastTasks();
  }

  // ---- repos ----
  createRepo(req: CreateRepoRequest): Repo {
    if (!req?.path) throw badRequest("path is required");
    const inspected = this.repositoryPaths.inspect(req.path, req.defaultBaseRef);
    if (!inspected.isGit && !inspected.isDirectory) throw badRequest(inspected.exists
      ? `not a directory: ${inspected.path}`
      : `no such directory: ${inspected.path}`);
    // Git paths snap to the work-tree root (registering /repo/sub must not
    // scatter hidden worktree directories inside subdirectories); a plain directory with no
    // git registers as-is (vcs "none" — tasks run in place, no worktree).
    // Dedupe by path — re-adding returns the existing entry.
    const path = inspected.path;
    const existing = this.db.listRepos().find((r) => r.path === path);
    if (existing) return existing;
    const repo: Repo = {
      id: this.ids.next("r"),
      name: req.name || inspected.name,
      path,
      vcs: inspected.isGit ? "git" : "none",
      defaultBaseRef: inspected.defaultBaseRef,
      createdAt: Date.now(),
    };
    this.db.insertRepo(repo);
    return repo;
  }
  deleteRepo(id: string): Repo {
    const repo = this.getRepo(id);
    const live = [...this.cache.values()].filter((t) => t.repoId === id && t.status !== "archived");
    if (live.length) throw conflict(`repo has ${live.length} non-archived task(s) — archive them first`);
    if (this.terminalLifecycle?.list({ repoId: id }).some(t => ["starting", "running", "closing"].includes(t.state))) throw conflict("Close this Space\'s terminals before removing it");
    if (this.db.hasRunningRoutine(id)) throw conflict("Stop this Space's running scripts before removing it");
    this.db.deleteRepo(id);
    this.hub.emitReadChange({ type: "read-change", usage: true, routines: true });
    this.attachments.prune();
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
    const all = [...this.cache.values()].map(t => this.withMessageQueue(t)).sort((a, b) => a.createdAt - b.createdAt);
    return status ? all.filter((t) => t.status === status) : all;
  }
  getTask(id: string): TaskState {
    const t = this.cache.get(id);
    if (!t) throw notFound(`no such task: ${id}`);
    return this.withMessageQueue(t);
  }
  private withMessageQueue(t: TaskState): TaskState {
    const queue = this.messages.snapshot(t.taskId);
    if (queue.revision > 0) t.messageQueue = queue;
    return t;
  }

  private assertSessionOwnership(task: TaskState): void {
    if (task.sessionControl && task.sessionControl.owner !== "palmagent") {
      throw conflict("This session is controlled in a local shell. Dispatch it back after closing the local CLI.");
    }
  }

  rename(id: string, title: string): TaskState {
    const task = this.getTask(id);
    if (task.title === title) return task;
    const now = Date.now();
    // Display metadata only: no agent event, activity bump, or ownership handoff.
    this.db.setTaskTitle(id, title, now);
    task.title = title;
    task.updatedAt = now;
    this.broadcastTasks();
    return task;
  }

  handoff(id: string): SessionHandoffResponse {
    const task = this.getTask(id);
    if (task.sessionControl?.owner === "local") return { task, command: this.nativeSession.resumeCommand(task) };
    this.assertSessionOwnership(task);
    if (this.supervisor.has(id) || !["idle", "failed"].includes(task.status)) throw conflict("Stop the active turn and wait for it to finish before handing off");
    if (!task.sessionId) throw conflict("This task has no native session yet");
    let control: TaskState["sessionControl"];
    try { control = this.nativeSession.checkpoint(task); } catch (error) { throw conflict(error instanceof Error ? error.message : "Native session is unavailable"); }
    this.messages.pause(id);
    this.db.setSessionControl(id, control);
    task.sessionControl = control;
    this.broadcastTasks();
    return { task, command: this.nativeSession.resumeCommand(task) };
  }

  // This entry point is exposed only on the owner-only local control socket.
  dispatchSession(req: DispatchSessionRequest): TaskState {
    this.assertTaskAdmission();
    if (!req || !["claude", "codex"].includes(req.agent) || typeof req.cwd !== "string" || typeof req.home !== "string") throw badRequest("agent, sessionId, cwd and provider home are required");
    let task = this.listTasks().find((t) => t.agent === req.agent && t.sessionId === req.sessionId);
    const { cwd, home, transcript, identity } = this.nativeSession.resolveDispatch(
      req, task?.sessionControl?.home ?? this.nativeSession.home(req.agent),
    );
    if (task) {
      if (this.nativeSession.realpath(task.worktreePath!) !== cwd || !task.sessionControl || task.sessionControl.owner === "palmagent") throw conflict("This session is already controlled by Palmagent or has a different working directory");
      if (task.sessionControl.owner === "returning" && (task.sessionControl.waitPid !== req.waitPid || task.sessionControl.waitIdentity !== identity)) throw conflict("A different local writer is already returning this session");
    } else {
      const now = Date.now();
      const repo = this.createRepo({ path: cwd });
      task = { taskId: this.ids.next("t"), repoId: repo.id, agent: req.agent, prompt: "Imported local session", title: "Local session", status: "idle", interrupted: false,
        sessionId: req.sessionId, worktreePath: cwd, permission: DEFAULT_PERMISSION[req.agent], createdAt: now, updatedAt: now, lastActivityAt: now,
        sessionControl: { owner: "local", home, transcript, cursor: 0, prefixHash: this.nativeSession.emptyTranscriptHash } };
      this.db.insertTask(task);
      this.cache.set(task.taskId, task);
      this.hub.emitReadChange({ type: "read-change", usage: true });
    }
    const control = { ...task.sessionControl!, owner: "returning" as const, waitPid: req.waitPid, waitIdentity: identity, error: undefined };
    this.db.setSessionControl(task.taskId, control);
    task.sessionControl = control;
    this.broadcastTasks();
    return task;
  }

  reconcileLocalSessions(): void {
    for (const task of this.cache.values()) {
      const control = task.sessionControl;
      if (control?.owner !== "returning") continue;
      try {
        if (!control.waitPid || !control.waitIdentity) throw new Error("Missing local writer identity");
        const preview = this.nativeSession.processIdentity(control.waitPid) === control.waitIdentity;
        const synced = this.nativeSession.synchronize(task, { preview });
        if (preview && synced.control.cursor === control.cursor && !control.error) continue;
        const updated = { ...task, sessionControl: synced.control };
        const rows = this.db.importSessionEvents(updated, synced.events);
        if (rows.some(row => row.event.kind === "result")) this.hub.emitReadChange({ type: "read-change", usage: true });
        this.refreshPrs(task);
        task.sessionControl = synced.control;
        if (rows.length) task.lastActivityAt = Date.now();
        for (const row of rows) this.hub.emitEvent(row);
        this.broadcastTasks();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Session synchronization failed";
        if (control.error === message) continue;
        const failed = { ...control, error: message };
        this.db.setSessionControl(task.taskId, failed);
        task.sessionControl = failed;
        this.broadcastTasks();
      }
    }
  }

  // ---- GitHub PR status (github.ts implements the fetch; we are its sink) ----
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
    this.assertTaskAdmission();
    if (req?.agent !== "claude" && req?.agent !== "codex") throw badRequest("agent must be 'claude' or 'codex'");
    if (!req.prompt) throw badRequest("prompt is required");
    const images = sanitizeImages(req.images);
    const repo = this.db.getRepo(req.repoId);
    if (!repo) throw badRequest(`no such repo: ${req.repoId}`);

    const taskId = this.ids.next("t");
    const now = Date.now();
    // Worktree isolation is opt-in (req.isolate): a git task that asks for it
    // gets its own worktree+branch — created first, so a failure aborts the task
    // (caller gets 500). Otherwise (the default, and always for plain folders /
    // vcs "none") the task runs in place: the registered directory is its stable
    // cwd and there is no branch.
    const wt =
      req.isolate && repo.vcs !== "none" ? this.worktrees.create(repo, taskId) : undefined;
    const skills = req.skills?.map(skill => {
      const path = wt && skill.path?.startsWith(repo.path + "/") ? wt.path + skill.path.slice(repo.path.length) : skill.path;
      return { ...skill, path, id: skillId({ agent: req.agent, home: this.nativeSession.home(req.agent) }, skill.name, path) };
    });
    const task: TaskState = {
      taskId,
      repoId: repo.id,
      agent: req.agent,
      title: req.title,
      prompt: req.prompt,
      skills,
      status: "queued",
      interrupted: false,
      sessionControl: { owner: "palmagent", home: this.nativeSession.home(req.agent), transcript: "", cursor: 0, prefixHash: this.nativeSession.emptyTranscriptHash },
      branch: wt?.branch,
      worktreePath: wt?.path ?? repo.path,
      permission: req.permission ?? defaultPermission(req.agent),
      model: req.model ?? defaultModel(req.agent, this.defaults),
      effort: req.effort ?? defaultEffort(req.agent, this.defaults),
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    };
    const attachments = this.db.transaction(() => {
      this.db.insertTask(task);
      return this.attachments.save(taskId, images);
    });
    this.cache.set(taskId, task);
    this.hub.emitReadChange({ type: "read-change", usage: true });
    this.broadcastTasks();
    // Emit the dispatch prompt into the event log (like followup/steer) so the
    // task view renders it from the live stream, not just the inbox snapshot —
    // otherwise opening a fresh task before its snapshot lands shows no prompt.
    const nImages = images?.length ?? 0;
    this.emitSynthetic(task, { subtype: "dispatch", text: req.prompt, skills, attachments, images: nImages || undefined });
    void this.runTurn(task, req.prompt, undefined, images, undefined, skills); // new session
    return task;
  }

  followup(id: string, prompt: string, rawImages?: unknown, model?: string, effort?: string, permission?: string): TaskState {
    this.assertTaskAdmission();
    const task = this.getTask(id);
    this.assertSessionOwnership(task);
    if (!prompt) throw badRequest("prompt is required");
    const images = sanitizeImages(rawImages);
    if (this.supervisor.has(id)) throw conflict("a turn is already active");
    if (task.status !== "idle" && task.status !== "failed") {
      throw conflict(`cannot follow up a ${task.status} task`);
    }
    const attachments = this.attachments.save(id, images);
    this.applySettings(task, model, effort, permission); // resumes with the new model/effort/permission if changed
    const nImages = images?.length ?? 0;
    this.emitSynthetic(task, { subtype: "followup", text: prompt, attachments, images: nImages || undefined });
    void this.runTurn(task, prompt, task.sessionId, images); // resume by id off the local transcript
    return task;
  }

  steer(id: string, text: string, rawImages?: unknown, model?: string, effort?: string, permission?: string): SteerResponse {
    if (!this.supervisor.has(id)) this.assertTaskAdmission();
    const task = this.getTask(id);
    this.assertSessionOwnership(task);
    if (!text) throw badRequest("text is required");
    const images = sanitizeImages(rawImages);
    const nImages = images?.length ?? 0;
    const attachments = this.supervisor.has(id) || ["idle", "failed"].includes(task.status)
      ? this.attachments.save(id, images) : undefined;
    // Persist any model/effort/permission override up front — every turn reads it off the task.
    const settingsChanged = this.applySettings(task, model, effort, permission);
    const handle = this.supervisor.get(id);
    if (handle) {
      // A running process can't adopt new flags, so a changed model/effort must
      // run as a fresh resumed turn rather than a mid-turn injection.
      if (settingsChanged) {
        const q = this.pendingSteer.get(id) ?? [];
        q.push({ text, images: images ?? [] });
        this.pendingSteer.set(id, q); this.persistControl(id);
        // Claude can interrupt now so the new settings take effect immediately;
        // Codex can't, so the queued steer chains when the current turn ends.
        this.steerRestart.add(id); this.persistControl(id);
        const restarted = handle.interrupt();
        if (!restarted) { this.steerRestart.delete(id); this.persistControl(id); }
        this.emitSynthetic(task, {
          subtype: "steer", injected: false, queued: true, restarted, text,
          model: task.model, effort: task.effort, permission: task.permission, attachments, images: nImages || undefined,
        });
        return { injected: false, queued: true, restarted };
      }
      // Claude: control_request interrupt (true). Codex: no channel (false).
      if (handle.steer(text, images)) {
        this.emitSynthetic(task, { subtype: "steer", injected: true, text, attachments, images: nImages || undefined });
        return { injected: true, queued: false };
      }
      const q = this.pendingSteer.get(id) ?? [];
      q.push({ text, images: images ?? [] });
      this.pendingSteer.set(id, q); this.persistControl(id);
      this.emitSynthetic(task, { subtype: "steer", injected: false, queued: true, text, attachments, images: nImages || undefined });
      return { injected: false, queued: true };
    }
    // No active turn: run the steer as an immediate follow-up if resumable.
    if (task.status === "idle" || task.status === "failed") {
      void this.runTurn(task, text, task.sessionId, images);
      this.emitSynthetic(task, { subtype: "steer", injected: false, queued: false, text, attachments, images: nImages || undefined, note: "ran as follow-up" });
      return { injected: false, queued: false };
    }
    this.emitSynthetic(task, { subtype: "steer", injected: false, queued: false, text, note: `ignored in ${task.status}` });
    return { injected: false, queued: false };
  }

  approve(id: string, decision: string, scope?: string): TaskState {
    const task = this.getTask(id);
    this.assertSessionOwnership(task);
    const pending = task.pendingApproval;
    const handle = this.supervisor.get(id);
    // New provider permission prompts carry a durable request and must be
    // delivered to the live adapter before the task can resume. Keep the old
    // event-only approval path usable for historical tasks that predate that
    // request payload.
    if (pending && !handle?.approve(decision, scope)) {
      throw conflict("Approval delivery could not be confirmed. The request has been kept; check the conversation before trying again.");
    }
    const now = Date.now();
    this.db.insertApproval(id, null, pending ? JSON.stringify({ request: pending, scope }) : scope ? JSON.stringify({ scope }) : null, decision, now);
    if (pending) {
      task.pendingApproval = undefined;
      this.db.setTaskPendingApproval(id, undefined, now);
    }
    if (task.status === "awaiting_approval") this.transition(task, "running");
    this.emitSynthetic(task, { subtype: "approval", decision, scope });
    return task;
  }

  // Answer a pending AskUserQuestion: hand the picks to the live turn (which
  // writes the control_response that unblocks the CLI), record the answer as a
  // synthetic event (shown as a "You" bubble), clear the pending question, and
  // resume `running`. 409 if the task isn't actually paused on a question.
  async answer(id: string, req: AnswerRequest): Promise<TaskState> {
    const task = this.getTask(id);
    this.assertSessionOwnership(task);
    if (task.status !== "awaiting_input") throw conflict(`task is not awaiting input (${task.status})`);
    if (!req?.requestId) throw badRequest("requestId is required");
    const handle = this.supervisor.get(id);
    if (task.pendingInput?.requestId !== req.requestId) throw conflict("no matching pending question to answer");
    if (!await handle?.answer(req)) throw conflict("Answer delivery could not be confirmed. The question has been kept; check the conversation before trying again.");
    // The turn may finish, stop, or ask another question while delivery is pending.
    // Independent hosts also replay a durable answer event, including across restarts.
    if (!this.shuttingDown && this.resolveInput(task, req.requestId)) {
      this.emitSynthetic(task, { subtype: "answer", requestId: req.requestId, answers: req.answers, response: req.response });
    }
    return task;
  }

  private resolveInput(task: TaskState, requestId: string): boolean {
    if (task.pendingInput?.requestId !== requestId) return false;
    task.pendingInput = undefined;
    this.db.setTaskPendingInput(task.taskId, undefined, Date.now());
    if (task.status === "awaiting_input") this.transition(task, "running");
    else this.broadcastTasks();
    return true;
  }

  // Stop = interrupt the current turn but keep the task resumable. Unlike
  // cancel, the worktree and session survive: the task settles
  // idle(interrupted=true) and a follow-up resumes off the CLI transcript.
  stop(id: string): TaskState {
    const task = this.getTask(id);
    this.assertSessionOwnership(task);
    if (task.status === "cancelled" || task.status === "archived") {
      throw conflict(`cannot stop a ${task.status} task`);
    }
    this.messages.pause(id);
    const handle = this.supervisor.get(id);
    if (handle) {
      this.pendingSteer.delete(id); this.persistControl(id); // stop wins over a queued codex steer
      this.stopping.add(id); this.persistControl(id);
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
      this.messages.stopWaiting(id);
    }
    return task; // idle/failed: nothing to stop (idempotent)
  }

  cancel(id: string): TaskState {
    const task = this.getTask(id);
    this.assertSessionOwnership(task);
    if (task.status === "cancelled" || task.status === "archived") return task; // idempotent
    this.messages.pause(id);
    this.pendingSteer.delete(id); this.persistControl(id);
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
    this.assertSessionOwnership(task);
    if (task.status === "archived") return task; // idempotent
    if (this.supervisor.has(id)) throw conflict("cancel the active turn before archiving");
    this.messages.pause(id);
    this.transition(task, "archived");
    this.cleanupWorktree(task);
    return task;
  }

  // ---- turn execution ----
  private async runTurn(task: TaskState, prompt: string, resumeId?: string, images?: ImageAttachment[], messageId?: string, skills?: SkillSelection[]): Promise<void> {
    const runId = this.messages.beginRun(task.taskId, messageId);
    if (!this.backend.independent && !this.supervisor.tryAcquire()) {
      this.transition(task, "queued"); // over the concurrency cap — wait for a slot
      await this.supervisor.acquire();
      // The wait is the only interleave point: bail if the task was cancelled,
      // archived, or stopped (→ idle) while queued.
      if (this.shuttingDown || task.status !== "queued" || this.messages.state(task.taskId).runId !== runId) {
        this.supervisor.release(task.taskId);
        return;
      }
    }
    if (skills?.length) {
      this.transition(task, "queued");
      try { skills = await this.resolveSkills({ taskId: task.taskId }, skills); }
      catch (error) {
        this.supervisor.release(task.taskId);
        if (this.shuttingDown || this.messages.state(task.taskId).runId !== runId || task.status !== "queued") return;
        const message = error instanceof Error ? error.message : "Skill is unavailable.";
        this.emitSynthetic(task, { subtype: "error", message });
        this.transition(task, "failed"); this.messages.rejectBeforeStart(task.taskId, message); return;
      }
      if (this.shuttingDown || this.messages.state(task.taskId).runId !== runId || ["cancelled", "archived"].includes(task.status)) {
        this.supervisor.release(task.taskId); return;
      }
    }
    this.startTurnNow(task, prompt, resumeId, images, messageId, skills);
  }

  private startTurnNow(task: TaskState, prompt: string, resumeId?: string, images?: ImageAttachment[], messageId?: string, skills?: SkillSelection[]): void {
    if (this.shuttingDown) { this.supervisor.release(task.taskId); return; }
    const runner = this.backend.agentRunner(task.agent);
    this.sessionMismatch.delete(task.taskId);
    this.turnState.set(task.taskId, { sawResult: false, lastResultError: false, errored: false });
    // A brand-new turn starts a fresh stdout stream: baseline 0, nothing replayed.
    this.turnBaseline.set(task.taskId, 0);
    this.db.setTaskRawSeq(task.taskId, 0);
    this.transition(task, "running", { interrupted: false });
    let handle: RunHandle;
    this.messages.startingRuntime(task.taskId);
    try {
      handle = runner.start(
        {
          taskId: task.taskId,
          messageId, interactive: true,
          cwd: task.worktreePath!, // stable for the task's whole life
          prompt,
          skills,
          images,
          resumeId,
          providerHome: task.sessionControl?.home,
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
      this.messages.finish(task.taskId, true);
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
    const runner = this.backend.agentRunner(task.agent);
    this.turnState.set(task.taskId, { sawResult: false, lastResultError: false, errored: false });
    const baseline = this.db.getTaskRawSeq(task.taskId);
    this.turnBaseline.set(task.taskId, baseline);
    const handle = runner.start(
      {
        taskId: task.taskId,
        cwd: task.worktreePath!,
        messageId: this.messages.state(task.taskId).initialMessageId,
        interactive: this.messages.state(task.taskId).protocol === "interactive",
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
        pendingApproval: task.pendingApproval,
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
    if (this.shuttingDown) return;
    if (this.sessionMismatch.has(task.taskId)) return;
    if (task.sessionId && raw.sessionId && task.sessionId !== raw.sessionId) {
      this.sessionMismatch.add(task.taskId);
      const state = this.turnState.get(task.taskId);
      if (state) { state.errored = true; state.abnormalExit = true; }
      this.pendingSteer.delete(task.taskId); this.persistControl(task.taskId);
      raw = { taskId: task.taskId, sessionId: task.sessionId, kind: "error", payload: { message: "The CLI returned a different session identity. The turn was stopped; the original session is retained." } };
      queueMicrotask(() => this.supervisor.get(task.taskId)?.cancel());
    }
    const now = Date.now();
    const output = raw.kind === "tool_result" || raw.kind === "tool_call" || raw.kind === "status" ? extractOutputImages(raw.payload) : { payload: raw.payload, images: [] };
    const event = { ...raw, payload: output.payload, agent: task.agent, ts: now };

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

    if (event.kind === "status") {
      const p = event.payload as { subtype?: string; messageId?: string; requestId?: string };
      if (p.subtype === "message_delivered" && p.messageId) this.messages.delivered(task.taskId, p.messageId);
      if ((p.subtype === "answer" || p.subtype === "input_resolved") && p.requestId) this.resolveInput(task, p.requestId);
    }

    if (this.backend.independent && task.status !== "cancelled" && event.kind === "status") {
      const subtype = (event.payload as { subtype?: string }).subtype;
      if (subtype === "execution_queued") this.transition(task, "queued");
      if (subtype === "execution_started") this.transition(task, "running");
    }
    if (event.kind === "approval_request" && task.status === "running") {
      const request = event.payload as PermissionRequest;
      task.pendingApproval = request;
      this.db.setTaskPendingApproval(task.taskId, request, now);
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

    // Commit all images from this source line with the event and replay cursor.
    // A restart cannot preserve the cursor while dropping an image from that line.
    const events = [event, ...output.images.map((image) => ({ ...event, kind: "output_image" as const, payload: image }))];
    const rows = this.db.appendAgentEvents(task.taskId, events, rawSeq);
    if (rows.some(row => row.event.kind === "result")) this.hub.emitReadChange({ type: "read-change", usage: true });
    if (event.kind === "tool_result") this.refreshPrs(task);
    task.lastActivityAt = now;
    for (const row of rows) this.hub.emitEvent(row);
  }

  private refreshPrs(task: TaskState): void {
    const saved = this.db.getTask(task.taskId);
    const prs = saved?.prs;
    if (JSON.stringify(prs) === JSON.stringify(task.prs)) return;
    task.prs = prs;
    task.updatedAt = saved?.updatedAt ?? task.updatedAt;
    task.prUrl = prs?.[0]?.url;
    this.broadcastTasks();
    this.requestPrRefresh?.(task.taskId);
  }

  private finishTurn(task: TaskState): void {
    if (this.shuttingDown) return;
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
    if (task.pendingApproval) {
      task.pendingApproval = undefined;
      this.db.setTaskPendingApproval(task.taskId, undefined, Date.now());
    }
    // A steer that changed model/effort interrupted this turn on purpose so the
    // queued steer can resume with the new flags — its aborted result is not a
    // real failure (which would suppress the chain below).
    const steerRestart = this.steerRestart.delete(task.taskId);
    this.persistControl(task.taskId);

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
      this.messages.finish(task.taskId, true);
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

    this.messages.finish(task.taskId, failed, false);

    // Legacy-client compatibility: old steers drain separately from the explicit queue.
    const pending = this.pendingSteer.get(task.taskId);
    const chains = !failed && !!pending && pending.length > 0;
    if (chains && pending) {
      this.pendingSteer.delete(task.taskId); this.persistControl(task.taskId);
      void this.runTurn(
        task,
        pending.map((p) => p.text).join("\n"),
        task.sessionId,
        pending.flatMap((p) => p.images),
      );
    }
    if (!chains && !failed) this.messages.pump(task.taskId);
    // Notify the phone only when the task actually settles (not when a queued
    // steer immediately chains into the next turn).
    if (!chains && !this.messages.state(task.taskId).runId) {
      this.notifyPush(
        task,
        failed ? "failed" : "finished",
        failed ? "The turn errored — open to inspect." : task.prUrl ? `Done. PR: ${task.prUrl}` : "Turn finished — task is idle.",
      );
    }
  }

  private persistControl(taskId: string) {
    this.backend.saveControl?.(taskId, { stopping: this.stopping.has(taskId), steerRestart: this.steerRestart.has(taskId), pendingSteer: this.pendingSteer.get(taskId) ?? [] });
  }

  // ---- helpers ----
  // Apply a model / effort / permission override onto the task (persisted; every
  // turn reads them off the task). Per field: undefined = leave as-is, "" = reset
  // to the agent's default (clear the override), any other value = set it.
  // Returns whether anything actually changed.
  private applySettings(task: TaskState, model?: string, effort?: string, permission?: string): boolean {
    const nextModel = model === undefined ? task.model : model === "" ? defaultModel(task.agent, this.defaults) : model;
    const nextEffort = effort === undefined ? task.effort : effort === "" ? defaultEffort(task.agent, this.defaults) : effort;
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
    const rows = this.db.appendAgentEvents(task.taskId, [
      { taskId: task.taskId, agent: task.agent, kind: "status", sessionId: task.sessionId, payload, ts: now },
    ]);
    for (const row of rows) this.hub.emitEvent(row);
  }

  private cleanupWorktree(task: TaskState): void {
    // No branch = plain-folder task: its cwd is the registered directory
    // itself — never remove it.
    if (!task.worktreePath || !task.branch) return;
    const repo = this.db.getRepo(task.repoId);
    if (repo) {
      const remove = () => this.worktrees.remove(repo, { branch: task.branch!, path: task.worktreePath! });
      if (this.terminalLifecycle) this.terminalLifecycle.cleanup(task.worktreePath, task.taskId, remove);
      else remove();
    }
  }

  private broadcastTasks(): void {
    this.hub.emitTasks(this.listTasks());
  }

  private notifyPush(task: TaskState, what: string, body: string): void {
    const title = `${task.agent} ${what}: ${headline(task)}`;
    this.push?.notify({ title, body, taskId: task.taskId, url: `/#/task/${task.taskId}` });
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

function defaultModel(agent: AgentKind, defaults: TaskDefaults): string | undefined {
  return defaults.model[agent];
}

function defaultEffort(agent: AgentKind, defaults: TaskDefaults): string | undefined {
  return defaults.effort[agent];
}

function defaultPermission(agent: AgentKind): string {
  return DEFAULT_PERMISSION[agent];
}
