import { projectContextUsage } from "./context-usage.js";
import { projectConfirmedPrs } from "../../domain/pr-projection.js";
import Database from "better-sqlite3";
import { PrEvidence, type PrEvidenceState } from "./pr-evidence.js";
import type { AgentEvent, AgentKind, AgentUsage, Permission, PermissionRequest, PrRef, PushSubscriptionJson, QuestionRequest, TaskState, TaskStatus } from "@palmagent/shared";
import { deferActivityEventDetails, HISTORY_PAGE_EVENTS, makePrRef } from "@palmagent/shared";
import type { AttachmentRecord, EventRow, MessageState } from "../../domain/models.js";

type TaskRow = {
  id: string; repo_id: string; agent: string; title: string | null; prompt: string; pinned_at: number | null;
  status: string; interrupted: number; session_id: string | null; branch: string | null;
  worktree_path: string | null; permission: string; model: string | null; effort: string | null;
  session_control: string | null;
  skills_json: string | null;
  context_usage_json?: string | null;
  pr_url: string | null; pr_urls: string | null; pending_input: string | null; pending_approval: string | null;
  created_at: number; updated_at: number; last_activity_at: number;
};

type EventJoinRow = {
  id: number; seq: number; task_id: string; kind: string; payload_json: string; ts: number;
  agent: string; session_id: string | null;
};

function parsePrs(r: TaskRow): PrRef[] | undefined {
  if (r.pr_urls) {
    try {
      const prs = JSON.parse(r.pr_urls) as PrRef[];
      if (Array.isArray(prs) && prs.length) return prs;
    } catch {
      /* fall through to legacy */
    }
  }
  if (r.pr_url) {
    const ref = makePrRef(r.pr_url);
    if (ref) return [ref];
  }
  return undefined;
}

function rowToTask(r: TaskRow): TaskState {
  return {
    taskId: r.id,
    contextUsage: r.context_usage_json ? JSON.parse(r.context_usage_json) : undefined,
    pinnedAt: r.pinned_at ?? undefined,
    repoId: r.repo_id,
    agent: r.agent as AgentKind,
    title: r.title ?? undefined,
    prompt: r.prompt,
    status: r.status as TaskStatus,
    interrupted: r.interrupted === 1,
    sessionId: r.session_id ?? undefined,
    sessionControl: r.session_control ? JSON.parse(r.session_control) : undefined,
    skills: r.skills_json ? JSON.parse(r.skills_json) : undefined,
    branch: r.branch ?? undefined,
    worktreePath: r.worktree_path ?? undefined,
    permission: r.permission as Permission,
    model: r.model ?? undefined,
    effort: r.effort ?? undefined,
    prs: parsePrs(r),
    prUrl: r.pr_url ?? undefined,
    pendingInput: r.pending_input ? (JSON.parse(r.pending_input) as QuestionRequest) : undefined,
    pendingApproval: r.pending_approval ? (JSON.parse(r.pending_approval) as PermissionRequest) : undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastActivityAt: r.last_activity_at,
  };
}

function taskToRow(t: TaskState) {
  return {
    id: t.taskId,
    pinned_at: t.pinnedAt ?? null,
    repo_id: t.repoId,
    agent: t.agent,
    title: t.title ?? null,
    prompt: t.prompt,
    status: t.status,
    interrupted: t.interrupted ? 1 : 0,
    session_id: t.sessionId ?? null,
    session_control: t.sessionControl ? JSON.stringify(t.sessionControl) : null,
    skills_json: t.skills?.length ? JSON.stringify(t.skills) : null,
    branch: t.branch ?? null,
    worktree_path: t.worktreePath ?? null,
    permission: t.permission,
    model: t.model ?? null,
    effort: t.effort ?? null,
    pr_url: t.prs?.[0]?.url ?? t.prUrl ?? null,
    pr_urls: t.prs && t.prs.length ? JSON.stringify(t.prs) : null,
    pending_input: t.pendingInput ? JSON.stringify(t.pendingInput) : null,
    pending_approval: t.pendingApproval ? JSON.stringify(t.pendingApproval) : null,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    last_activity_at: t.lastActivityAt,
  };
}

function rowToEvent(r: EventJoinRow): EventRow {
  return {
    id: r.id,
    seq: r.seq,
    event: {
      taskId: r.task_id,
      agent: r.agent as AgentKind,
      kind: r.kind as AgentEvent["kind"],
      sessionId: r.session_id ?? undefined,
      payload: JSON.parse(r.payload_json),
      ts: r.ts,
    },
  };
}

export class SqliteTasks {
private insertEventStmt: Database.Statement;
private getSeqStmt: Database.Statement;
constructor(private readonly db: Database.Database) {
 this.initializeContextUsage();
 this.initializePrEvidence();
 this.insertEventStmt = db.prepare(`INSERT INTO events (task_id, seq, kind, payload_json, ts) VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE task_id = ?), ?, ?, ?)`);
 this.getSeqStmt = db.prepare("SELECT seq FROM events WHERE id = ?");
}
private initializeContextUsage(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_context_usage (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      context_usage_json TEXT
    )`);
    const tasks = this.db.prepare(`SELECT t.id, t.agent FROM tasks t LEFT JOIN task_context_usage c ON c.task_id = t.id
      WHERE c.task_id IS NULL`).all() as { id: string; agent: AgentKind }[];
    for (const task of tasks) this.db.transaction(() => {
      let usage: TaskState["contextUsage"];
      const rows = this.db.prepare(`SELECT payload_json, ts FROM events WHERE task_id = ? AND kind = 'status' ORDER BY seq`).iterate(task.id);
      for (const row of rows as Iterable<{ payload_json: string; ts: number }>) {
        usage = projectContextUsage(usage, { taskId: task.id, agent: task.agent, kind: "status", payload: JSON.parse(row.payload_json), ts: row.ts });
      }
      this.writeContextUsage(task.id, usage);
    })();
  }

private writeContextUsage(taskId: string, usage: TaskState["contextUsage"]): void {
    this.db.prepare(`INSERT INTO task_context_usage (task_id, context_usage_json) VALUES (?, ?)
      ON CONFLICT(task_id) DO UPDATE SET context_usage_json = excluded.context_usage_json`)
      .run(taskId, usage ? JSON.stringify(usage) : null);
  }

private projectContextEvents(taskId: string, events: AgentEvent[]): void {
    if (!events.some(event => event.kind === "status")) return;
    const previous = this.getTask(taskId)?.contextUsage;
    const next = events.reduce(projectContextUsage, previous);
    if (next !== previous) this.writeContextUsage(taskId, next);
  }

private initializePrEvidence(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_pr_evidence (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      state_json TEXT NOT NULL
    )`);
    const tasks = this.db.prepare(`SELECT t.* FROM tasks t LEFT JOIN task_pr_evidence p ON p.task_id = t.id
      WHERE p.task_id IS NULL`).all() as TaskRow[];
    for (const task of tasks) this.db.transaction(() => {
      const tracker = new PrEvidence();
      const previous = parsePrs(task) ?? [];
      const confirmed = new Set<string>();
      const rows = this.db.prepare(`SELECT kind, payload_json FROM events WHERE task_id = ? ORDER BY seq`).iterate(task.id);
      for (const row of rows as Iterable<{ kind: AgentEvent["kind"]; payload_json: string }>) {
        for (const url of tracker.accept({ kind: row.kind, payload: JSON.parse(row.payload_json), agent: task.agent as AgentKind })) {
          confirmed.add(url);
        }
      }
      this.writePrEvidence(task.id, tracker, projectConfirmedPrs(previous, confirmed, true));
    })();
  }

private writePrEvidence(taskId: string, tracker: PrEvidence, prs: PrRef[], now?: number): void {
    this.db.prepare(`INSERT INTO task_pr_evidence (task_id, state_json) VALUES (?, ?)
      ON CONFLICT(task_id) DO UPDATE SET state_json = excluded.state_json`)
      .run(taskId, JSON.stringify(tracker.snapshot()));
    this.db.prepare("UPDATE tasks SET pr_urls = ?, pr_url = ?, updated_at = COALESCE(?, updated_at) WHERE id = ?")
      .run(JSON.stringify(prs), prs[0]?.url ?? null, now ?? null, taskId);
  }

private projectPrEvents(taskId: string, events: AgentEvent[]): void {
    const row = this.db.prepare("SELECT state_json FROM task_pr_evidence WHERE task_id = ?").get(taskId) as { state_json: string } | undefined;
    const tracker = new PrEvidence(row ? JSON.parse(row.state_json) as PrEvidenceState : undefined);
    const urls = events.flatMap((event) => tracker.accept(event));
    if (row && !urls.length && row.state_json === JSON.stringify(tracker.snapshot())) return;
    const previous = this.getTask(taskId)?.prs ?? [];
    const prs = projectConfirmedPrs(previous, urls);
    this.writePrEvidence(taskId, tracker, prs, prs.length > previous.length ? Date.now() : undefined);
  }

get isOpen() { return this.db.open; }

readMessageState(id: string): MessageState | undefined {
    const row = this.db.prepare("SELECT state FROM task_message_state WHERE task_id = ?").get(id) as { state: string } | undefined;
    return row ? JSON.parse(row.state) : undefined;
  }

messageTaskIds(): string[] {
    return (this.db.prepare("SELECT task_id FROM task_message_state").all() as { task_id: string }[]).map(r => r.task_id);
  }

writeMessageState(id: string, state: MessageState) {
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO task_message_state (task_id, state) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET state = excluded.state").run(id, JSON.stringify(state));
    })();
  }

transaction<T>(work: () => T): T { return this.db.transaction(work).immediate(); }

attachment(taskId: string, id: string): AttachmentRecord | undefined {
    return this.db.prepare("SELECT id, task_id AS taskId, media_type AS mediaType, size, digest, unused_since AS unusedSince, expired_at AS expiredAt FROM attachments WHERE task_id = ? AND id = ?")
      .get(taskId, id) as AttachmentRecord | undefined;
  }

attachmentByDigest(taskId: string, digest: string): AttachmentRecord | undefined {
    return this.db.prepare("SELECT id, task_id AS taskId, media_type AS mediaType, size, digest, unused_since AS unusedSince, expired_at AS expiredAt FROM attachments WHERE task_id = ? AND digest = ?")
      .get(taskId, digest) as AttachmentRecord | undefined;
  }

insertAttachment(record: AttachmentRecord): void {
    this.db.prepare("INSERT INTO attachments (id, task_id, media_type, size, digest) VALUES (?, ?, ?, ?, ?)")
      .run(record.id, record.taskId, record.mediaType, record.size, record.digest);
  }

attachmentIds(): Set<string> {
    return new Set((this.db.prepare("SELECT id FROM attachments").all() as { id: string }[]).map(row => row.id));
  }

attachmentInventory(): (AttachmentRecord & { status: string; updatedAt: number })[] {
    return this.db.prepare(`SELECT a.id, a.task_id AS taskId, a.media_type AS mediaType, a.size, a.digest,
      a.unused_since AS unusedSince, a.expired_at AS expiredAt, t.status, t.updated_at AS updatedAt
      FROM attachments a JOIN tasks t ON t.id = a.task_id`).all() as ReturnType<SqliteTasks["attachmentInventory"]>;
  }

attachmentReferences(taskId: string): { history: Set<string>; pending: Set<string> } {
    const history = new Set<string>(), pending = new Set<string>();
    // Stream only user-message events, not the potentially large assistant transcript.
    const rows = this.db.prepare("SELECT payload_json FROM events WHERE task_id = ? AND kind = 'status'")
      .iterate(taskId) as Iterable<{ payload_json: string }>;
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json);
      for (const ref of payload?.attachments ?? []) {
        history.add(ref.id);
        for (const frame of ref.video?.frames ?? []) history.add(frame.id);
      }
    }
    for (const message of this.readMessageState(taskId)?.messages ?? []) {
      if (!["delivered", "cancelled"].includes(message.status)) {
        for (const ref of message.attachments ?? []) {
          pending.add(ref.id);
          for (const frame of ref.video?.frames ?? []) pending.add(frame.id);
        }
      }
    }
    return { history, pending };
  }

setAttachmentLifecycle(id: string, unusedSince: number | null, expiredAt: number | null): void {
    this.db.prepare("UPDATE attachments SET unused_since = ?, expired_at = ? WHERE id = ?")
      .run(unusedSince, expiredAt, id);
  }

deleteAttachment(id: string): void { this.db.prepare("DELETE FROM attachments WHERE id = ?").run(id); }

insertTask(t: TaskState) {
    this.db.prepare(
      `INSERT INTO tasks (id, repo_id, agent, title, pinned_at, prompt, status, interrupted, session_id,
         branch, worktree_path, permission, model, effort, pr_url, pr_urls, pending_input, pending_approval, session_control, skills_json, created_at, updated_at, last_activity_at)
       VALUES (@id, @repo_id, @agent, @title, @pinned_at, @prompt, @status, @interrupted, @session_id,
         @branch, @worktree_path, @permission, @model, @effort, @pr_url, @pr_urls, @pending_input, @pending_approval, @session_control, @skills_json, @created_at, @updated_at, @last_activity_at)`,
    ).run(taskToRow(t));
  }

getTask(id: string): TaskState | undefined {
    const row = this.db.prepare(`SELECT t.*, c.context_usage_json FROM tasks t LEFT JOIN task_context_usage c ON c.task_id = t.id WHERE t.id = ?`).get(id) as TaskRow | undefined;
    return row && rowToTask(row);
  }

listTasks(status?: TaskStatus): TaskState[] {
    const rows = status
      ? this.db.prepare(`SELECT t.*, c.context_usage_json FROM tasks t LEFT JOIN task_context_usage c ON c.task_id = t.id WHERE status = ? ORDER BY created_at`).all(status)
      : this.db.prepare(`SELECT t.*, c.context_usage_json FROM tasks t LEFT JOIN task_context_usage c ON c.task_id = t.id ORDER BY created_at`).all();
    return (rows as TaskRow[]).map(rowToTask);
  }

setSessionControl(id: string, control: TaskState["sessionControl"]) {
    this.db.prepare("UPDATE tasks SET session_control = ? WHERE id = ?").run(JSON.stringify(control), id);
  }

setTaskPin(id: string, pinned: boolean, now: number): number | undefined {
    // Keep creation order even when two pins share a millisecond or the clock moves back.
    const row = this.db.prepare(`UPDATE tasks SET pinned_at = CASE WHEN ? THEN
      COALESCE(pinned_at, (SELECT MAX(?, COALESCE(MAX(pinned_at) + 1, ?)) FROM tasks))
      ELSE NULL END, updated_at = ? WHERE id = ? RETURNING pinned_at`)
      .get(pinned ? 1 : 0, now, now, now, id) as { pinned_at: number | null };
    return row.pinned_at ?? undefined;
  }

setTaskTitle(id: string, title: string, now: number) {
    this.db.prepare("UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?").run(title, now, id);
  }

appendAgentEvents(taskId: string, events: AgentEvent[], rawSeq?: number): EventRow[] {
    return this.db.transaction(() => {
      const rows = events.map((event) => ({ ...this.insertEvent(taskId, event.kind, event.payload, event.ts), event }));
      this.projectPrEvents(taskId, events);
      this.projectContextEvents(taskId, events);
      if (rawSeq !== undefined) this.setTaskRawSeq(taskId, rawSeq);
      this.touchTask(taskId, Date.now());
      return rows;
    })();
  }

importSessionEvents(task: TaskState, events: AgentEvent[]): EventRow[] {
    return this.db.transaction(() => {
      const rows = events.map((event) => ({ ...this.insertEvent(task.taskId, event.kind, event.payload, event.ts), event }));
      this.projectPrEvents(task.taskId, events);
      this.projectContextEvents(task.taskId, events);
      this.setSessionControl(task.taskId, task.sessionControl);
      if (events.length) this.touchTask(task.taskId, Date.now());
      return rows;
    })();
  }

setTaskStatus(id: string, status: TaskStatus, interrupted: boolean, now: number) {
    this.db.prepare(
      `UPDATE tasks SET status = ?, interrupted = ?, updated_at = ?, pinned_at = CASE WHEN ? = 'archived' THEN NULL ELSE pinned_at END WHERE id = ?`,
    ).run(status, interrupted ? 1 : 0, now, status, id);
  }

setTaskSession(id: string, sessionId: string, now: number) {
    this.db.transaction(() => {
      if (this.getTask(id)?.sessionId !== sessionId) this.writeContextUsage(id, undefined);
      this.db.prepare(`UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?`).run(sessionId, now, id);
    })();
  }

setTaskSettings(id: string, model: string | undefined, effort: string | undefined, permission: string, now: number) {
    this.db.transaction(() => {
      const task = this.getTask(id);
      if (task?.model !== model && task?.contextUsage) this.writeContextUsage(id, { ...task.contextUsage, stale: true });
      this.db.prepare(
        `UPDATE tasks SET model = ?, effort = ?, permission = ?, updated_at = ? WHERE id = ?`,
      ).run(model ?? null, effort ?? null, permission, now, id);
    })();
  }

setTaskWorktree(id: string, branch: string, worktreePath: string, now: number) {
    this.db.prepare(
      `UPDATE tasks SET branch = ?, worktree_path = ?, updated_at = ? WHERE id = ?`,
    ).run(branch, worktreePath, now, id);
  }

touchTask(id: string, now: number) {
    this.db.prepare(`UPDATE tasks SET last_activity_at = ? WHERE id = ?`).run(now, id);
  }

setTaskPrs(id: string, prs: PrRef[], now: number) {
    this.db.prepare(`UPDATE tasks SET pr_urls = ?, pr_url = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(prs), prs[0]?.url ?? null, now, id,
    );
  }

setTaskPendingInput(id: string, pending: QuestionRequest | undefined, now: number) {
    this.db.prepare(`UPDATE tasks SET pending_input = ?, updated_at = ? WHERE id = ?`).run(
      pending ? JSON.stringify(pending) : null, now, id,
    );
  }

setTaskPendingApproval(id: string, pending: PermissionRequest | undefined, now: number) {
    this.db.prepare(`UPDATE tasks SET pending_approval = ?, updated_at = ? WHERE id = ?`).run(
      pending ? JSON.stringify(pending) : null, now, id,
    );
  }

setTaskRawSeq(id: string, seq: number) {
    this.db.prepare(`UPDATE tasks SET last_raw_seq = ? WHERE id = ?`).run(seq, id);
  }

getTaskRawSeq(id: string): number {
    const row = this.db.prepare(`SELECT last_raw_seq FROM tasks WHERE id = ?`).get(id) as
      | { last_raw_seq: number }
      | undefined;
    return row?.last_raw_seq ?? 0;
  }

inFlightTaskIds(): string[] {
    return (
      this.db.prepare(
        `SELECT id FROM tasks WHERE status IN ('running','awaiting_approval','awaiting_input','queued')`,
      ).all() as { id: string }[]
    ).map((r) => r.id);
  }

resetInterruptedTasks(ids: string[], now: number): void {
    const reset = this.db.prepare(`UPDATE tasks SET status='idle', interrupted=1, pending_input=NULL, pending_approval=NULL, updated_at=? WHERE id=?`);
    this.db.transaction(() => { for (const id of ids) reset.run(now, id); })();
  }

insertEvent(taskId: string, kind: string, payload: unknown, ts: number): { id: number; seq: number } {
    const info = this.insertEventStmt.run(taskId, taskId, kind, JSON.stringify(payload ?? null), ts);
    const id = Number(info.lastInsertRowid);
    const { seq } = this.getSeqStmt.get(id) as { seq: number };
    return { id, seq };
  }

eventCursor(taskId?: string): number {
    const row = taskId
      ? this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS cursor FROM events WHERE task_id = ?").get(taskId)
      : this.db.prepare("SELECT COALESCE(MAX(id), 0) AS cursor FROM events").get();
    return (row as { cursor: number }).cursor;
  }

eventsAfterGlobal(afterId: number, limit = 5000): EventRow[] {
    const rows = this.db.prepare(
      `SELECT e.id, e.seq, e.task_id, e.kind, e.payload_json, e.ts, t.agent, t.session_id
       FROM events e JOIN tasks t ON t.id = e.task_id
       WHERE e.id > ? ORDER BY e.id LIMIT ?`,
    ).all(afterId, limit) as EventJoinRow[];
    return rows.map(rowToEvent);
  }

eventsAfterSeq(taskId: string, afterSeq: number, limit = 5000): EventRow[] {
    const rows = this.db.prepare(
      `SELECT e.id, e.seq, e.task_id, e.kind, e.payload_json, e.ts, t.agent, t.session_id
       FROM events e JOIN tasks t ON t.id = e.task_id
       WHERE e.task_id = ? AND e.seq > ? ORDER BY e.seq LIMIT ?`,
    ).all(taskId, afterSeq, limit) as EventJoinRow[];
    return rows.map(rowToEvent);
  }

historyStart(taskId: string, before: number, limit = HISTORY_PAGE_EVENTS): number {
    const edge = this.db.prepare(`SELECT seq, kind FROM events
      WHERE task_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1 OFFSET ?`)
      .get(taskId, before, limit - 1) as { seq: number; kind: string } | undefined;
    if (!edge) return 1;
    if (edge.kind !== "assistant_text") return edge.seq;
    const previous = this.db.prepare(`SELECT seq FROM events
      WHERE task_id = ? AND seq < ? AND kind != 'assistant_text' ORDER BY seq DESC LIMIT 1`)
      .get(taskId, edge.seq) as { seq: number } | undefined;
    return (previous?.seq ?? 0) + 1;
  }

historyPage(taskId: string, before: number, cursor = this.eventCursor(taskId), includeActivityDetails = true): import("@palmagent/shared").TaskHistoryResponse {
    // Compact is the conversation, not a window over raw provider events. A
    // single collapsed Activity can span thousands of those events; paging it
    // would hide earlier messages and keep changing its count while reading.
    const start = includeActivityDetails ? this.historyStart(taskId, before) : 1;
    const rows = this.db.prepare(`SELECT e.id, e.seq, e.task_id, e.kind, e.payload_json, e.ts, t.agent, t.session_id
      FROM events e JOIN tasks t ON t.id = e.task_id
      WHERE e.task_id = ? AND e.seq >= ? AND e.seq < ? ORDER BY e.seq`)
      .iterate(taskId, start, before) as IterableIterator<EventJoinRow>;
    const events: import("@palmagent/shared").TaskHistoryEvent[] = [];
    // Discard each bulky tool payload before reading the next row instead of
    // materializing all full payloads for a compact conversation in memory.
    for (const row of rows) {
      const event = rowToEvent(row).event;
      events.push(includeActivityDetails ? { seq: row.seq, event }
        : { seq: row.seq, ...deferActivityEventDetails(event) });
    }
    return { events, before: start > 1 ? start : null, cursor };
  }

historyChanges(taskId: string, after: number, through?: number, includeActivityDetails = true): import("@palmagent/shared").TaskHistoryChangesResponse {
    const cursor = this.eventCursor(taskId);
    const end = Math.max(after, Math.min(through ?? cursor, cursor));
    const rows = end <= after ? [] : this.db.prepare(`SELECT e.id, e.seq, e.task_id, e.kind, e.payload_json, e.ts, t.agent, t.session_id
      FROM events e JOIN tasks t ON t.id = e.task_id
      WHERE e.task_id = ? AND e.seq > ? AND e.seq <= ? ORDER BY e.seq LIMIT ?`)
      .all(taskId, after, end, HISTORY_PAGE_EVENTS + 1) as EventJoinRow[];
    const hasMore = rows.length > HISTORY_PAGE_EVENTS;
    const page = (hasMore ? rows.slice(0, HISTORY_PAGE_EVENTS) : rows).map((row) => {
      const event = rowToEvent(row).event;
      if (includeActivityDetails) return { seq: row.seq, event };
      const compact = deferActivityEventDetails(event);
      return { seq: row.seq, ...compact };
    });
    return { events: page, after, through: end, nextAfter: hasMore ? page.at(-1)!.seq : null };
  }

activityDetails(taskId: string, from: number, through: number): import("@palmagent/shared").TaskActivityDetailsResponse {
    const cursor = this.eventCursor(taskId);
    const end = Math.min(through, cursor);
    const rows = end < from ? [] : this.db.prepare(`SELECT e.id, e.seq, e.task_id, e.kind, e.payload_json, e.ts, t.agent, t.session_id
      FROM events e JOIN tasks t ON t.id = e.task_id
      WHERE e.task_id = ? AND e.seq >= ? AND e.seq <= ? AND e.kind IN ('tool_call', 'tool_result') ORDER BY e.seq`)
      .all(taskId, from, end) as EventJoinRow[];
    return { events: rows.map((row) => ({ seq: row.seq, event: rowToEvent(row).event })), from, through: end, cursor };
  }

latestHistoryPage(taskId: string, includeActivityDetails = true): import("@palmagent/shared").TaskHistoryResponse {
    const cursor = this.eventCursor(taskId);
    return this.historyPage(taskId, cursor + 1, cursor, includeActivityDetails);
  }

usageByAgent(): AgentUsage[] {
    const acc = new Map<AgentKind, AgentUsage>();
    const bucket = (agent: AgentKind): AgentUsage => {
      let u = acc.get(agent);
      if (!u) {
        u = {
          agent, taskCount: 0, turnCount: 0, totalCostUsd: 0, durationMs: 0,
          inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, reported: [],
        };
        acc.set(agent, u);
      }
      return u;
    };
    // Tasks ever dispatched per agent (any final status counts as usage).
    for (const r of this.db.prepare(`SELECT agent, COUNT(*) AS n FROM tasks GROUP BY agent`).all() as {
      agent: string;
      n: number;
    }[]) {
      bucket(r.agent as AgentKind).taskCount = r.n;
    }
    // Fold every result payload into its owning agent's running totals.
    const rows = this.db.prepare(
      `SELECT t.agent AS agent, e.payload_json AS payload_json
       FROM events e JOIN tasks t ON t.id = e.task_id
       WHERE e.kind = 'result'`,
    ).all() as { agent: string; payload_json: string }[];
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    const add = (u: AgentUsage, key: NonNullable<AgentUsage["reported"]>[number], value: unknown) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
      u[key] += value;
      if (!u.reported!.includes(key)) u.reported!.push(key);
    };
    for (const row of rows) {
      const u = bucket(row.agent as AgentKind);
      u.turnCount += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const p = parsed as Record<string, unknown>;
      add(u, "totalCostUsd", p.total_cost_usd);
      add(u, "durationMs", p.duration_ms);
      const usage = p.usage;
      if (usage && typeof usage === "object") {
        const g = usage as Record<string, unknown>;
        // Claude reports cache reads/creation separately from uncached input;
        // Codex already includes cached tokens in its input total.
        add(u, "inputTokens", row.agent === "claude" && typeof g.input_tokens === "number" && Number.isFinite(g.input_tokens) && g.input_tokens >= 0
          ? num(g.input_tokens) + num(g.cache_read_input_tokens) + num(g.cache_creation_input_tokens) : g.input_tokens);
        add(u, "cachedInputTokens", row.agent === "claude" ? g.cache_read_input_tokens : g.cached_input_tokens);
        add(u, "outputTokens", g.output_tokens);
        add(u, "reasoningOutputTokens", g.reasoning_output_tokens);
      }
    }
    return [...acc.values()].sort((a, b) => a.agent.localeCompare(b.agent));
  }

insertApproval(taskId: string, eventId: number | null, requestJson: string | null, decision: string, decidedAt: number) {
    this.db.prepare(
      `INSERT INTO approvals (task_id, event_id, request_json, decision, decided_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(taskId, eventId, requestJson, decision, decidedAt);
  }

upsertPushSub(sub: PushSubscriptionJson, now: number) {
    this.db.prepare(
      `INSERT INTO push_subs (endpoint, subscription_json, created_at) VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET subscription_json = excluded.subscription_json`,
    ).run(sub.endpoint, JSON.stringify(sub), now);
  }

deletePushSub(endpoint: string) {
    this.db.prepare(`DELETE FROM push_subs WHERE endpoint = ?`).run(endpoint);
  }

listPushSubs(): PushSubscriptionJson[] {
    const rows = this.db.prepare(`SELECT subscription_json FROM push_subs`).all() as {
      subscription_json: string;
    }[];
    return rows.map((r) => JSON.parse(r.subscription_json) as PushSubscriptionJson);
  }
}
