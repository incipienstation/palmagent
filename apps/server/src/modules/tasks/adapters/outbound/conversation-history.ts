import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  appendHistoryEvent, activityLabel, deferActivityEventDetails, projectConversation, transcriptActivity,
  CONVERSATION_PAGE_ITEMS, CONVERSATION_PAGE_BYTES, CONVERSATION_ITEM_BYTES, CONVERSATION_DETAIL_ITEMS,
  type AgentEvent, type ConversationActivity, type ConversationContent, type ConversationDetails,
  type ConversationItem, type ConversationPatch, type LogItem, type TranscriptRow,
  type TaskHistoryResponse, type TaskHistoryChangesResponse, type ConversationSteps, type ExecutionRecords,
} from "@palmagent/shared";
import { ApplicationError } from "../../../../kernel/errors.js";

type State = { cursor: number; block_start: number; log_json: string; activity: ConversationActivity };
type StoredRow = { seq: number; end_seq: number; revision: number; body_json: string | null; wire_json: string | null };
type EventRow = { seq: number; kind: AgentEvent["kind"]; payload_json: string; ts: number; agent: AgentEvent["agent"]; session_id: string | null };
const version = (body: string) => createHash("sha256").update(body).digest("hex");
const reset = (event: AgentEvent) => event.kind === "status" &&
  ["dispatch", "followup", "turn_started"].includes(String((event.payload as { subtype?: unknown } | null)?.subtype));
const endOf = (row: TranscriptRow) => row.type === "message" ? row.item.endSeq ?? row.key
  : row.items.reduce((end, item) => Math.max(end, item.endSeq ?? item.key), row.key);

/** Durable display records. Event sequence remains the source of ordering and SSE recovery.
 * Only the unfinished run needs reclassification when a late phase marker arrives;
 * completed runs are indexed once. Text deltas are merged before storing that tail.
 */
export class ConversationHistory {
  constructor(private readonly db: Database.Database) {
    db.transaction(() => {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'conversation_rows'").get();
      db.exec("CREATE TABLE IF NOT EXISTS conversation_projection_version (version INTEGER NOT NULL)");
      const upgrade = (db.prepare("SELECT version FROM conversation_projection_version").get() as { version: number } | undefined)?.version !== 2;
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_rows (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL, block_start INTEGER NOT NULL, end_seq INTEGER NOT NULL,
          revision INTEGER NOT NULL, wire_json TEXT, body_json TEXT,
          PRIMARY KEY (task_id, seq)
        );
        CREATE INDEX IF NOT EXISTS conversation_visible ON conversation_rows(task_id, seq) WHERE wire_json IS NOT NULL;
        CREATE INDEX IF NOT EXISTS conversation_changes ON conversation_rows(task_id, revision, seq);
        CREATE INDEX IF NOT EXISTS conversation_blocks ON conversation_rows(task_id, block_start);
        CREATE TABLE IF NOT EXISTS conversation_state (
          task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          cursor INTEGER NOT NULL, block_start INTEGER NOT NULL, log_json TEXT NOT NULL, activity TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS conversation_dirty (
          task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, from_seq INTEGER NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS conversation_insert AFTER INSERT ON events BEGIN
          INSERT INTO conversation_dirty VALUES (NEW.task_id, NEW.seq)
          ON CONFLICT(task_id) DO UPDATE SET from_seq = MIN(from_seq, excluded.from_seq);
        END;
        CREATE TRIGGER IF NOT EXISTS conversation_update AFTER UPDATE OF kind, payload_json ON events BEGIN
          INSERT INTO conversation_dirty VALUES (NEW.task_id, NEW.seq)
          ON CONFLICT(task_id) DO UPDATE SET from_seq = MIN(from_seq, excluded.from_seq);
        END;
        CREATE TRIGGER IF NOT EXISTS conversation_delete AFTER DELETE ON events
        WHEN EXISTS (SELECT 1 FROM tasks WHERE id = OLD.task_id) BEGIN
          INSERT INTO conversation_dirty VALUES (OLD.task_id, OLD.seq)
          ON CONFLICT(task_id) DO UPDATE SET from_seq = MIN(from_seq, excluded.from_seq);
        END;
      `);
      if (!exists || upgrade) {
        // One transactional upgrade, including native imports from other writers.
        // Ordinary first-page reads never scan the completed conversation.
        db.exec("INSERT INTO conversation_dirty SELECT task_id, MIN(seq) FROM events GROUP BY task_id ON CONFLICT(task_id) DO UPDATE SET from_seq = MIN(from_seq, excluded.from_seq)");
        for (const { task_id } of db.prepare("SELECT task_id FROM conversation_dirty").all() as { task_id: string }[]) this.refresh(task_id);
      }
      if (upgrade) db.exec("DELETE FROM conversation_projection_version; INSERT INTO conversation_projection_version VALUES (2)");
    }).immediate();
  }

  private state(taskId: string): State {
    return this.db.prepare("SELECT cursor, block_start, log_json, activity FROM conversation_state WHERE task_id = ?")
      .get(taskId) as State ?? { cursor: 0, block_start: 1, log_json: "[]", activity: "working" };
  }

  private head(taskId: string): Pick<State, "cursor" | "activity"> {
    return this.db.prepare("SELECT cursor, activity FROM conversation_state WHERE task_id = ?").get(taskId) as Pick<State, "cursor" | "activity">
      ?? { cursor: 0, activity: "working" };
  }

  private wire(row: TranscriptRow, revision: number, member?: { key: number; body: string; seq: number }): ConversationItem {
    const full = JSON.stringify(row);
    let item: ConversationItem = { ...row, endSeq: endOf(row), revision };
    if (row.type === "activity") item = { ...item, ...row, items: [], operations: undefined,
      summary: { label: activityLabel(row, "compact"), count: row.operations?.length ?? row.items.length,
        running: row.operations?.find(step => step.state === "running")?.title,
        failed: row.operations?.filter(step => step.state === "error").length }, details: true,
      preview: row.preview?.slice(0, 240) } as ConversationItem;
    if (Buffer.byteLength(JSON.stringify(item)) <= CONVERSATION_ITEM_BYTES) return item;
    const source = row.type === "message" ? row.item : undefined;
    const preview = source?.kind === "assistant_text" ? source.text.slice(0, 2000)
      : source && typeof (source.event.payload as { text?: unknown } | null)?.text === "string"
        ? (source.event.payload as { text: string }).text.slice(0, 2000) : "";
    const label = source?.kind === "output_image" ? "Load image" : row.type === "failure" ? "Load error details" : "Load full message";
    // The placeholder is explicitly expandable; no message or tool content is lost.
    const placeholder: LogItem = source?.kind === "status" ? { ...source, event: { ...source.event, kind: "status",
      payload: { subtype: (source.event.payload as { subtype?: unknown } | null)?.subtype,
        text: preview, messageId: (source.event.payload as { messageId?: unknown } | null)?.messageId } } }
      : { key: row.key, endSeq: endOf(row), kind: "assistant_text", agent: source?.kind === "assistant_text" ? source.agent : source?.event.agent ?? "codex", text: preview };
    item = { type: "message", key: row.key, endSeq: endOf(row), revision,
      item: placeholder,
      content: { key: member?.key ?? row.key, version: version(member?.body ?? full), ...(member ? { member: member.seq } : {}), label } };
    return item;
  }

  private saveBlock(taskId: string, start: number, log: LogItem[], revision: number, previous: boolean): void {
    const prior = new Map((this.db.prepare("SELECT seq, end_seq, revision, body_json, wire_json FROM conversation_rows WHERE task_id = ? AND block_start = ?")
      .all(taskId, start) as StoredRow[]).map(row => [row.seq, row]));
    const identities = new Map<number, number>();
    for (const old of prior.values()) {
      if (!old.body_json) continue;
      const row = JSON.parse(old.body_json) as TranscriptRow;
      if (row.type === "activity") for (const member of row.items) identities.set(member.key, row.disclosureKey ?? row.key);
    }
    const usedIdentities = new Set<number>();
    const save = this.db.prepare(`INSERT INTO conversation_rows (task_id, seq, block_start, end_seq, revision, body_json, wire_json) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, seq) DO UPDATE SET block_start=excluded.block_start, end_seq=excluded.end_seq,
        revision=excluded.revision, body_json=excluded.body_json, wire_json=excluded.wire_json`);
    for (const original of projectConversation(log, !previous)) {
      const row = original.type === "failure" && previous ? { ...original, previous: true } : original;
      if (row.type === "activity") {
        row.disclosureKey = row.items.map(member => identities.get(member.key)).find(key => key !== undefined && !usedIdentities.has(key))
          ?? row.items.find(member => !usedIdentities.has(member.key))?.key ?? row.key;
        usedIdentities.add(row.disclosureKey);
      }
      const body = JSON.stringify(row), old = prior.get(row.key);
      prior.delete(row.key);
      if (old?.body_json === body) continue;
      save.run(taskId, row.key, start, endOf(row), revision, body, JSON.stringify(this.wire(row, revision)));
    }
    const remove = this.db.prepare("UPDATE conversation_rows SET revision = ?, body_json = NULL, wire_json = NULL WHERE task_id = ? AND seq = ?");
    for (const old of prior.values()) if (old.body_json !== null) remove.run(revision, taskId, old.seq);
  }

  update(taskId: string): void { this.refresh(taskId); }

  private refresh(taskId: string): void {
    const work = () => {
      const dirty = this.db.prepare("SELECT from_seq FROM conversation_dirty WHERE task_id = ?").get(taskId) as { from_seq: number } | undefined;
      if (!dirty) return;
      const state = this.state(taskId);
      let cursor = state.cursor, start = state.block_start, log = JSON.parse(state.log_json) as LogItem[];
      if (dirty.from_seq <= cursor) {
        // Historical correction/deletion: repair from the preceding semantic boundary.
        const edge = this.db.prepare(`SELECT seq FROM events WHERE task_id = ? AND seq < ? AND kind = 'status'
          AND json_extract(payload_json, '$.subtype') IN ('dispatch', 'followup', 'turn_started') ORDER BY seq DESC LIMIT 1`)
          .get(taskId, dirty.from_seq) as { seq: number } | undefined;
        start = edge?.seq ?? 1; cursor = start - 1; log = [];
        const latest = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE task_id = ?").get(taskId) as { seq: number }).seq;
        this.db.prepare("UPDATE conversation_rows SET revision = ?, body_json = NULL, wire_json = NULL WHERE task_id = ? AND block_start >= ?")
          .run(latest, taskId, start);
      }
      const read = this.db.prepare(`SELECT e.seq, e.kind, COALESCE(c.payload_json, e.payload_json) AS payload_json, e.ts, t.agent, t.session_id
        FROM events e JOIN tasks t ON t.id = e.task_id LEFT JOIN event_compact_payloads c ON c.event_id = e.id
        WHERE e.task_id = ? AND e.seq > ? ORDER BY e.seq LIMIT 512`);
      while (true) {
        const rows = read.all(taskId, cursor) as EventRow[];
        if (!rows.length) break;
        for (const row of rows) {
          const event = { taskId, agent: row.agent, kind: row.kind, payload: JSON.parse(row.payload_json), ts: row.ts,
            sessionId: row.session_id ?? undefined } as AgentEvent;
          if (reset(event) && log.length) {
            this.saveBlock(taskId, start, log, row.seq, true);
            log = []; start = row.seq;
          }
          const compact = deferActivityEventDetails(event);
          appendHistoryEvent(log, compact.event, row.seq, compact.detailsDeferred);
          cursor = row.seq;
        }
      }
      this.saveBlock(taskId, start, log, cursor, false);
      const activity = transcriptActivity(log, { running: true });
      this.db.prepare(`INSERT INTO conversation_state VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET cursor=excluded.cursor, block_start=excluded.block_start, log_json=excluded.log_json, activity=excluded.activity`)
        .run(taskId, cursor, start, JSON.stringify(log), activity);
      this.db.prepare("DELETE FROM conversation_dirty WHERE task_id = ?").run(taskId);
    };
    if (!this.db.prepare("SELECT 1 FROM conversation_dirty WHERE task_id = ?").get(taskId)) return;
    if (this.db.inTransaction) work(); else this.db.transaction(work).immediate();
  }

  page(taskId: string, before?: number): TaskHistoryResponse {
    this.refresh(taskId);
    return this.db.transaction(() => {
      const state = this.head(taskId);
      const rows = this.db.prepare(`SELECT seq, wire_json FROM conversation_rows INDEXED BY conversation_visible
        WHERE task_id = ? AND seq < ? AND wire_json IS NOT NULL ORDER BY seq DESC LIMIT ?`)
        .all(taskId, before ?? Number.MAX_SAFE_INTEGER, CONVERSATION_PAGE_ITEMS + 1) as Pick<StoredRow, "seq" | "wire_json">[];
      const transcript: ConversationItem[] = [];
      let bytes = 1024;
      for (const row of rows) {
        const size = Buffer.byteLength(row.wire_json!);
        if (transcript.length >= CONVERSATION_PAGE_ITEMS || bytes + size > CONVERSATION_PAGE_BYTES) break;
        transcript.push(JSON.parse(row.wire_json!)); bytes += size;
      }
      const earlier = rows.length > transcript.length ? transcript.at(-1)!.key : null;
      return { events: [], transcript: transcript.reverse(), before: earlier, cursor: state.cursor, activity: state.activity };
    })();
  }

  changes(taskId: string, after: number, through?: number, afterKey = Number.MAX_SAFE_INTEGER): TaskHistoryChangesResponse {
    this.refresh(taskId);
    return this.db.transaction(() => {
      const state = this.head(taskId), end = Math.max(after, Math.min(through ?? state.cursor, state.cursor));
      const rows = this.db.prepare(`SELECT seq, revision, wire_json FROM conversation_rows
        WHERE task_id = ? AND revision >= ? AND revision <= ? AND (revision > ? OR seq > ?)
        ORDER BY revision, seq LIMIT ?`).all(taskId, after, end, after, afterKey, CONVERSATION_PAGE_ITEMS + 1) as StoredRow[];
      const transcript: ConversationPatch[] = [];
      let bytes = 1024;
      for (const row of rows) {
        const patch = { key: row.seq, revision: row.revision, item: row.wire_json ? JSON.parse(row.wire_json) as ConversationItem : null };
        const size = Buffer.byteLength(JSON.stringify(patch));
        if (transcript.length >= CONVERSATION_PAGE_ITEMS || bytes + size > CONVERSATION_PAGE_BYTES) break;
        transcript.push(patch); bytes += size;
      }
      const more = rows.length > transcript.length, last = transcript.at(-1);
      return { events: [], transcript, after, through: end, nextAfter: more ? last!.revision : null,
        ...(more ? { nextKey: last!.key } : {}), ...(end === state.cursor ? { activity: state.activity } : {}) };
    })();
  }

  private record(taskId: string, key: number): StoredRow & { body_json: string } {
    const row = this.db.prepare("SELECT seq, end_seq, revision, body_json, wire_json FROM conversation_rows WHERE task_id = ? AND seq = ? AND body_json IS NOT NULL")
      .get(taskId, key) as StoredRow & { body_json: string } | undefined;
    if (!row) throw new ApplicationError("not_found", "Conversation item is no longer available.");
    return row;
  }

  private detail(taskId: string, item: LogItem): TranscriptRow {
    if (item.kind === "assistant_text" || !item.detailsDeferred) return { type: "message", key: item.key, item };
    const row = this.db.prepare("SELECT payload_json FROM events WHERE task_id = ? AND seq = ?").get(taskId, item.key) as { payload_json: string } | undefined;
    if (!row) throw new ApplicationError("not_found", "Activity detail is no longer available.");
    return { type: "message", key: item.key, item: { ...item, detailsDeferred: false, event: { ...item.event, payload: JSON.parse(row.payload_json) } } };
  }

  details(taskId: string, key: number, after = 0): ConversationDetails {
    this.refresh(taskId);
    return this.db.transaction(() => {
      const record = this.record(taskId, key), row = JSON.parse(record.body_json) as TranscriptRow;
      const members = row.type === "message" ? [row.item] : row.items;
      const remaining = members.filter(item => item.key > after).sort((a, b) => a.key - b.key);
      const items: ConversationItem[] = [];
      let bytes = 1024;
      for (const member of remaining.slice(0, CONVERSATION_DETAIL_ITEMS + 1)) {
        const detail = this.detail(taskId, member);
        const item = this.wire(detail, record.revision, { key, body: JSON.stringify(detail), seq: member.key });
        const size = Buffer.byteLength(JSON.stringify(item));
        if (items.length >= CONVERSATION_DETAIL_ITEMS || bytes + size > CONVERSATION_PAGE_BYTES) break;
        items.push(item); bytes += size;
      }
      return { items, nextAfter: remaining.length > items.length ? items.at(-1)!.key : null, cursor: record.revision };
    })();
  }

  steps(taskId: string, key: number, after = 0): ConversationSteps {
    this.refresh(taskId);
    return this.db.transaction(() => {
      const record = this.record(taskId, key), row = JSON.parse(record.body_json) as TranscriptRow;
      const operations = row.type === "activity" ? row.operations ?? [] : [];
      const remaining = operations.filter(step => step.key > after).sort((a, b) => a.key - b.key);
      const steps = remaining.slice(0, CONVERSATION_DETAIL_ITEMS).map(({ members: _members, ...step }) => step);
      return { steps, nextAfter: remaining.length > steps.length ? steps.at(-1)!.key : null, cursor: record.revision };
    })();
  }

  private eventDetail(taskId: string, seq: number): TranscriptRow {
    const event = this.rawEvent(taskId, seq), items: LogItem[] = [];
    appendHistoryEvent(items, event, seq);
    return { type: "message", key: seq, item: items[0] };
  }

  private rawEvent(taskId: string, seq: number): AgentEvent {
    const row = this.db.prepare(`SELECT e.seq, e.kind, e.payload_json, e.ts, t.agent, t.session_id
      FROM events e JOIN tasks t ON t.id = e.task_id WHERE e.task_id = ? AND e.seq = ?`).get(taskId, seq) as EventRow | undefined;
    if (!row) throw new ApplicationError("not_found", "Execution record is no longer available.");
    return { taskId, agent: row.agent, kind: row.kind, payload: JSON.parse(row.payload_json), ts: row.ts,
      sessionId: row.session_id ?? undefined } as AgentEvent;
  }

  stepDetails(taskId: string, key: number, stepKey: number, after = 0): ConversationDetails {
    this.refresh(taskId);
    return this.db.transaction(() => {
      const record = this.record(taskId, key), row = JSON.parse(record.body_json) as TranscriptRow;
      const step = row.type === "activity" ? row.operations?.find(step => step.key === stepKey) : undefined;
      if (!step) throw new ApplicationError("not_found", "This operation changed. Reload its activity.");
      const remaining = step.members.filter(seq => seq > after).sort((a, b) => a - b);
      const items: ConversationItem[] = [];
      let bytes = 1024;
      for (const seq of remaining.slice(0, CONVERSATION_DETAIL_ITEMS)) {
        const member = row.type === "activity" ? row.items.find(item => item.key === seq) : undefined;
        const detail = member ? this.detail(taskId, member) : this.eventDetail(taskId, seq);
        const item = this.wire(detail, record.revision, { key, body: JSON.stringify(detail), seq });
        const size = Buffer.byteLength(JSON.stringify(item));
        if (bytes + size > CONVERSATION_PAGE_BYTES) break;
        items.push(item); bytes += size;
      }
      return { items, nextAfter: remaining.length > items.length ? items.at(-1)!.key : null, cursor: record.revision };
    })();
  }

  records(taskId: string, before?: number): ExecutionRecords {
    return this.db.transaction(() => {
      const cursor = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE task_id = ?").get(taskId) as { seq: number }).seq;
      const rows = this.db.prepare("SELECT seq FROM events WHERE task_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
        .all(taskId, before ?? cursor + 1, CONVERSATION_DETAIL_ITEMS + 1) as { seq: number }[];
      const records: ExecutionRecords["records"] = [];
      let bytes = 1024;
      for (const { seq } of rows.slice(0, CONVERSATION_DETAIL_ITEMS)) {
        const event = this.rawEvent(taskId, seq), body = JSON.stringify(event, null, 2);
        const record = { key: seq, kind: event.kind, agent: event.agent, ts: event.ts, version: version(body),
          ...(Buffer.byteLength(body) <= CONVERSATION_ITEM_BYTES ? { body } : {}) };
        const size = Buffer.byteLength(JSON.stringify(record));
        if (bytes + size > CONVERSATION_PAGE_BYTES) break;
        records.push(record); bytes += size;
      }
      return { records: records.reverse(), before: rows.length > records.length ? records[0]!.key : null, cursor };
    })();
  }

  recordContent(taskId: string, key: number, expectedVersion: string, offset: number): ConversationContent {
    const body = JSON.stringify(this.rawEvent(taskId, key), null, 2);
    if (version(body) !== expectedVersion) throw new ApplicationError("conflict", "This record changed. Refresh the execution records.");
    if (offset > body.length) throw new ApplicationError("bad_request", "Invalid content offset.");
    const next = Math.min(body.length, offset + 16_384);
    return { chunk: body.slice(offset, next), nextOffset: next < body.length ? next : null, version: expectedVersion };
  }

  content(taskId: string, key: number, expectedVersion: string, offset: number, member?: number): ConversationContent {
    this.refresh(taskId);
    return this.db.transaction(() => {
      const record = this.record(taskId, key);
      let body = record.body_json;
      if (member !== undefined) {
        const row = JSON.parse(body) as TranscriptRow;
        const item = (row.type === "message" ? [row.item] : row.items).find(item => item.key === member);
        const linked = row.type === "activity" && row.operations?.some(step => step.members.includes(member));
        if (!item && !linked) throw new ApplicationError("not_found", "Activity detail is no longer available.");
        body = JSON.stringify(item ? this.detail(taskId, item) : this.eventDetail(taskId, member));
      }
      if (version(body) !== expectedVersion) throw new ApplicationError("conflict", "This message changed. Reload its content.");
      if (offset > body.length) throw new ApplicationError("bad_request", "Invalid content offset.");
      // UTF-16 boundaries are intentional: concatenating JSON chunks restores the
      // exact string, including surrogate pairs, before parsing it on the client.
      const next = Math.min(body.length, offset + 16_384);
      return { chunk: body.slice(offset, next), nextOffset: next < body.length ? next : null, version: expectedVersion };
    })();
  }
}
