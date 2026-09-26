import type {
  AccountLimits, AgentEvent, AgentKind, AgentUsage, ImageAttachment, PermissionRequest, PrRef, PushPayload,
  PushSubscriptionJson, QuestionRequest, Repo, Routine, RoutineRun, SkillCatalog, SkillContext, SkillSelection,
  TaskActivityDetailsResponse, TaskHistoryChangesResponse, TaskHistoryResponse, TaskState, TaskStatus,
  VoiceClientTimings, VoiceConnection, SseReadChangeFrame,
} from "@palmagent/shared";
import type { Attachment } from "@palmagent/shared";
import type { AttachmentRecord, EventRow, MessageState, StoredCredential } from "./models.js";
import type { TerminalSession } from "@palmagent/shared/terminals";
import type { DispatchSessionRequest } from "@palmagent/shared";
import type { RunHandle } from "./models.js";

/** Port implemented by the durable task/event adapter. */
export interface TaskRepository extends RepoRepository, MessageStateRepository, TaskHistoryReader {
  getTask(id: string): TaskState | undefined;
  listTasks(status?: TaskStatus): TaskState[];
  insertTask(task: TaskState): void;
  setSessionControl(id: string, control: TaskState["sessionControl"]): void;
  setTaskTitle(id: string, title: string, now: number): void;
  setTaskStatus(id: string, status: TaskStatus, interrupted: boolean, now: number): void;
  setTaskSession(id: string, sessionId: string, now: number): void;
  setTaskSettings(id: string, model: string | undefined, effort: string | undefined, permission: string, now: number): void;
  setTaskPrs(id: string, prs: PrRef[], now: number): void;
  setTaskPendingInput(id: string, pending: QuestionRequest | undefined, now: number): void;
  setTaskPendingApproval(id: string, pending: PermissionRequest | undefined, now: number): void;
  setTaskRawSeq(id: string, seq: number): void;
  getTaskRawSeq(id: string): number;
  appendAgentEvents(taskId: string, events: AgentEvent[], rawSeq?: number): EventRow[];
  importSessionEvents(task: TaskState, events: AgentEvent[]): EventRow[];
  inFlightTaskIds(): string[];
  recoverInFlight(now: number, keep?: Set<string>): string[];
  insertApproval(taskId: string, eventId: number | null, requestJson: string | null, decision: string, decidedAt: number): void;
  usageByAgent(): AgentUsage[];
  transaction<T>(work: () => T): T;
  hasRunningRoutine(repoId: string): boolean;
}

export interface TaskDefaults {
  model: Partial<Record<import("@palmagent/shared").AgentKind, string>>;
  effort: Partial<Record<import("@palmagent/shared").AgentKind, string>>;
}

export interface RepoRepository {
  insertRepo(repo: Repo): void;
  getRepo(id: string): Repo | undefined;
  listRepos(): Repo[];
  deleteRepo(id: string): void;
}

export interface MessageStateRepository {
  readonly isOpen: boolean;
  readMessageState(id: string): MessageState | undefined;
  messageTaskIds(): string[];
  writeMessageState(id: string, state: MessageState): void;
}

export interface AttachmentIndex {
  readonly path: string;
  readonly isOpen: boolean;
  transaction<T>(work: () => T): T;
  attachment(taskId: string, id: string): AttachmentRecord | undefined;
  attachmentByDigest(taskId: string, digest: string): AttachmentRecord | undefined;
  insertAttachment(record: AttachmentRecord): void;
  attachmentInventory(): (AttachmentRecord & { status: string; updatedAt: number })[];
  attachmentReferences(taskId: string): { history: Set<string>; pending: Set<string> };
  deleteAttachment(id: string): void;
  setAttachmentLifecycle(id: string, unusedSince: number | null, expiredAt: number | null): void;
}

export interface AttachmentStorage {
  start(): void;
  close(): void;
  prune(): void;
  save(taskId: string, images?: readonly ImageAttachment[]): Attachment[] | undefined;
  read(taskId: string, id: string): { bytes: Buffer; mediaType: string };
  load(taskId: string, attachments?: readonly Attachment[]): ImageAttachment[] | undefined;
}

export interface AuthRepository {
  countCredentials(): number;
  getSession(token: string): { token: string; createdAt: number; expiresAt: number } | undefined;
  deleteSession(token: string): void;
  refreshSession(token: string, expiresAt: number): void;
  createSession(token: string, createdAt: number, expiresAt: number, label?: string): void;
  isEnrollTokenValid(token: string, now: number): boolean;
  listCredentials(): StoredCredential[];
  consumeEnrollToken(token: string, now: number): boolean;
  insertCredential(credential: StoredCredential): void;
  getCredential(id: string): StoredCredential | undefined;
  bumpCredentialCounter(id: string, counter: number, lastUsedAt: number): void;
  createEnrollToken(token: string, expiresAt: number): void;
}

export interface PushRepository {
  upsertPushSub(subscription: PushSubscriptionJson, now: number): void;
  deletePushSub(endpoint: string): void;
  listPushSubs(): PushSubscriptionJson[];
}

export interface RoutineRepository extends RepoRepository {
  interruptRoutineRuns(): void;
  listRoutines(): Routine[];
  updateRoutine(routine: Routine): void;
  insertRoutineRun(run: Omit<RoutineRun, "id">): number;
  insertRoutine(routine: Routine): void;
  getRoutine(id: string): Routine | undefined;
  deleteRoutine(id: string): void;
  hasRunningRoutine(repoId: string): boolean;
  listRoutineRuns(id: string, limit?: number): RoutineRun[];
  finishRoutineRun(id: number, result: Pick<RoutineRun, "status" | "note" | "finishedAt" | "exitCode" | "output" | "worktreePath">): void;
}

export interface RoutineScriptExecution {
  stop(reason?: string): void;
  done: Promise<void>;
}

export interface RoutineScriptRunner {
  start(repository: RoutineRepository, routine: Routine, runId: number): RoutineScriptExecution;
}

export interface TaskAttachmentReader {
  read(taskId: string, attachmentId: string): { bytes: Buffer; mediaType: string };
  load(taskId: string, attachments?: readonly Attachment[]): ImageAttachment[] | undefined;
}

export interface TaskHistoryReader {
  eventCursor(taskId?: string): number;
  historyPage(taskId: string, before: number, cursor?: number, includeActivityDetails?: boolean): TaskHistoryResponse;
  latestHistoryPage(taskId: string, includeActivityDetails?: boolean): TaskHistoryResponse;
  historyChanges(taskId: string, after: number, through?: number, includeActivityDetails?: boolean): TaskHistoryChangesResponse;
  activityDetails(taskId: string, from: number, through: number): TaskActivityDetailsResponse;
}

export interface TaskImageReader {
  read(worktreePath: string | undefined, requestedPath: string | string[]): Promise<{ bytes: Buffer; mediaType: string }>;
}

export interface PrStatusSink {
  tasksWithPrs(): { taskId: string; prs: PrRef[] }[];
  applyPrStatuses(taskId: string, patches: Map<string, Partial<PrRef>>): void;
}

export interface TaskEventPublisher {
  emitEvent(row: EventRow): void;
  emitTasks(tasks: TaskState[]): void;
  emitReadChange(change: SseReadChangeFrame): void;
}

export interface LiveEventStream extends TaskEventPublisher {
  onUpdates(listener: () => void): () => void;
  onEvent(listener: (row: EventRow) => void): () => void;
  onTasks(listener: (tasks: TaskState[]) => void): () => void;
  onReadChange(listener: (change: SseReadChangeFrame) => void): () => void;
}

export interface TerminalTaskLifecycle {
  list(query: { repoId: string }): Pick<TerminalSession, "state">[];
  cleanup(cwd: string, taskId: string, removeWorktree: () => void): void;
}

export interface RoutineTaskUseCases {
  readonly updating: boolean;
  createTask(input: import("@palmagent/shared").CreateTaskRequest): TaskState;
}

export interface TaskSupervisor {
  tryAcquire(): boolean;
  acquire(): Promise<void>;
  register(taskId: string, handle: RunHandle): void;
  reclaim(taskId: string, handle: RunHandle): void;
  get(taskId: string): RunHandle | undefined;
  has(taskId: string): boolean;
  release(taskId: string): void;
}

export interface TaskWorktreeManager {
  create(repo: Repo, taskId: string): { branch: string; path: string };
  remove(repo: Repo, worktree: { branch: string; path: string }): void;
}

export interface TaskPushNotifier {
  notify(payload: PushPayload): void;
}

export interface TaskVoiceOperations {
  start(home: string, sdp: string, signal?: AbortSignal): Promise<VoiceConnection>;
  touch(id: string): void;
  stop(id: string, timings?: VoiceClientTimings): void;
  close(): void;
}

export interface TaskSkillCatalog {
  list(environment: TaskSkillEnvironment): Promise<SkillCatalog>;
  resolve(environment: TaskSkillEnvironment, selected?: SkillSelection[]): Promise<SkillSelection[] | undefined>;
}

export interface TaskSkillEnvironment { agent: AgentKind; cwd: string; home: string }

export interface TaskAccountLimitReader {
  get(agent: AgentKind, home: string): Promise<AccountLimits>;
}

export interface RepositoryPathInspection {
  path: string;
  name: string;
  exists: boolean;
  isDirectory: boolean;
  isGit: boolean;
  defaultBaseRef: string;
}

export interface RepositoryPathOperations {
  inspect(path: string, defaultBaseRef?: string): RepositoryPathInspection;
}

export interface NativeSessionDispatch {
  cwd: string;
  home: string;
  transcript: string;
  identity: string;
}

export interface NativeSessionOperations {
  readonly emptyTranscriptHash: string;
  home(agent: AgentKind): string;
  realpath(path: string): string;
  processIdentity(pid: number): string | undefined;
  checkpoint(task: TaskState): TaskState["sessionControl"];
  resumeCommand(task: TaskState): string;
  resolveDispatch(request: DispatchSessionRequest, expectedHome: string): NativeSessionDispatch;
  synchronize(task: TaskState, options?: { preview?: boolean }): { control: NonNullable<TaskState["sessionControl"]>; events: AgentEvent[] };
}

export interface IdentifierGenerator {
  next(prefix: string): string;
}
