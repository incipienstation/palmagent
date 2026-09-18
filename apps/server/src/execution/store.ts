import Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { ensurePrivateDirectory, ensurePrivateFile } from "../private-files.js";
import { processIdentity } from "../native-session.js";
import { ExecutionStartSchema, ExecutionCommandSchema, EXECUTION_PROTOCOL, type ExecutionStart, type ExecutionCommand, type ExecutionCommandResult } from "@palmagent/shared/executions";
import type { RawEvent } from "../types.js";

export interface ExecutionRecord {
  id: string; taskId: string; protocol: number; release: string; node: string;
  args: ExecutionStart; state: "queued" | "starting" | "running" | "finished" | "lost";
  pid: number | null; identity: string | null; question: string | null; lastSeq: number;
}
interface Stored extends Omit<ExecutionRecord, "args"> { args: string }
export interface CommandRecord { id: string; execution: string; body: ExecutionCommand; result: ExecutionCommandResult }

/** Stable execution authority. Web/product database migrations never touch it. */
export class ExecutionStore {
  readonly db: Database.Database;
  constructor(readonly directory: string) {
    ensurePrivateDirectory(directory);
    const path = join(directory, "executions.sqlite");
    this.db = new Database(path);
    ensurePrivateFile(path);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    const version = this.db.pragma("user_version", { simple: true });
    if (version !== 0 && version !== EXECUTION_PROTOCOL) { this.db.close(); throw new Error("Unsupported execution store version"); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, taskId TEXT NOT NULL, protocol INTEGER NOT NULL,
        release TEXT NOT NULL, node TEXT NOT NULL, args TEXT NOT NULL,
        state TEXT NOT NULL, ownerKey TEXT NOT NULL, pid INTEGER, identity TEXT,
        question TEXT, lastSeq INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS live_task ON executions(taskId) WHERE state IN ('queued','starting','running');
      CREATE UNIQUE INDEX IF NOT EXISTS live_owner ON executions(ownerKey) WHERE state IN ('queued','starting','running');
      CREATE TABLE IF NOT EXISTS events (execution TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(execution,seq));
      CREATE TABLE IF NOT EXISTS commands (execution TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, result TEXT NOT NULL, claimed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(execution,id));
      CREATE TABLE IF NOT EXISTS admission_settings (id INTEGER PRIMARY KEY CHECK(id=1), capacity INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS control_state (taskId TEXT PRIMARY KEY, body TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
  }
  close() { this.db.close(); }
  saveControl(taskId: string, state: unknown) { this.db.prepare("INSERT INTO control_state VALUES (?,?) ON CONFLICT(taskId) DO UPDATE SET body=excluded.body").run(taskId, JSON.stringify(state)); }
  loadControl(taskId: string): unknown {
    const row = this.db.prepare("SELECT body FROM control_state WHERE taskId=?").get(taskId) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  get(id: string): ExecutionRecord {
    const row = this.db.prepare("SELECT * FROM executions WHERE id=?").get(id) as Stored | undefined;
    if (!row) throw new Error("Execution not found");
    return { ...row, args: ExecutionStartSchema.parse(JSON.parse(row.args)) };
  }
  latest(taskId: string): ExecutionRecord | undefined {
    const row = this.db.prepare("SELECT id FROM executions WHERE taskId=? ORDER BY rowid DESC LIMIT 1").get(taskId) as { id: string } | undefined;
    return row && this.get(row.id);
  }
  list(): ExecutionRecord[] {
    return (this.db.prepare("SELECT id FROM executions ORDER BY rowid").all() as { id: string }[]).map(({ id }) => this.get(id));
  }
  reserve(input: ExecutionStart, release: string, node: string): ExecutionRecord {
    const args = ExecutionStartSchema.parse(input);
    return this.db.transaction(() => {
      const existing = this.latest(args.taskId);
      if (existing && ["queued", "starting", "running"].includes(existing.state)) {
        if (args.messageId && existing.args.messageId === args.messageId && JSON.stringify(existing.args) === JSON.stringify(args)) return existing;
        throw new Error("An execution already owns this task");
      }
      const id = randomUUID();
      const ownerKey = createHash("sha256").update(JSON.stringify([args.agent, args.providerHome ?? "", args.resumeId ?? id])).digest("hex");
      this.db.prepare("INSERT INTO executions(id,taskId,protocol,release,node,args,state,ownerKey,createdAt) VALUES (?,?,?,?,?,?,'queued',?,?)")
        .run(id, args.taskId, EXECUTION_PROTOCOL, release, node, JSON.stringify(args), ownerKey, Date.now());
      this.append(id, { taskId: args.taskId, kind: "status", payload: { subtype: "execution_queued" } });
      return this.get(id);
    }).immediate();
  }
  setCapacity(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid execution capacity");
    this.db.prepare("INSERT INTO admission_settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET capacity=excluded.capacity").run(capacity);
  }
  admit(limit: number): ExecutionRecord[] {
    return this.db.transaction(() => {
      const settings = this.db.prepare("SELECT capacity FROM admission_settings WHERE id=1").get() as { capacity: number } | undefined;
      limit = settings?.capacity ?? limit;
      const { count } = this.db.prepare("SELECT count(*) AS count FROM executions WHERE state IN ('starting','running')").get() as { count: number };
      const rows = this.db.prepare("SELECT id FROM executions WHERE state='queued' ORDER BY rowid LIMIT ?").all(Math.max(0, limit - count)) as { id: string }[];
      for (const { id } of rows) this.db.prepare("UPDATE executions SET state='starting' WHERE id=?").run(id);
      return rows.map(({ id }) => this.get(id));
    }).immediate();
  }
  bindSession(id: string, sessionId: string): void {
    const row = this.get(id);
    const ownerKey = createHash("sha256").update(JSON.stringify([row.args.agent, row.args.providerHome ?? "", sessionId])).digest("hex");
    this.db.prepare("UPDATE executions SET ownerKey=? WHERE id=? AND state='running'").run(ownerKey, id);
  }
  claim(id: string): boolean {
    const identity = processIdentity(process.pid);
    if (!identity) throw new Error("Cannot establish execution host identity");
    return this.db.prepare("UPDATE executions SET state='running',pid=?,identity=? WHERE id=? AND state='starting' AND pid IS NULL")
      .run(process.pid, identity, id).changes === 1;
  }
  append(id: string, event: RawEvent): number {
    return this.db.transaction(() => {
      const seq = this.get(id).lastSeq + 1;
      this.db.prepare("INSERT INTO events VALUES (?,?,?)").run(id, seq, JSON.stringify(event));
      this.db.prepare("UPDATE executions SET lastSeq=? WHERE id=?").run(seq, id);
      if (event.kind === "question") this.db.prepare("UPDATE executions SET question=? WHERE id=?").run(JSON.stringify(event.payload), id);
      if (event.kind === "status" && (event.payload as { subtype?: string }).subtype === "input_resolved") {
        this.clearQuestion(id, (event.payload as { requestId: string }).requestId);
      }
      return seq;
    }).immediate();
  }
  events(id: string, after: number): { seq: number; event: RawEvent }[] {
    return (this.db.prepare("SELECT seq,body FROM events WHERE execution=? AND seq>? ORDER BY seq LIMIT 256").all(id, after) as { seq: number; body: string }[])
      .map(({ seq, body }) => ({ seq, event: JSON.parse(body) as RawEvent }));
  }
  cancelBeforeStart(id: string): boolean {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (!["queued", "starting"].includes(row.state) || row.pid !== null) return false;
      this.append(id, { taskId: row.taskId, kind: "status", payload: { subtype: "process_exit", code: -1 } });
      this.finish(id);
      return true;
    }).immediate();
  }
  finish(id: string, lost = false) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE executions SET state=?,question=NULL WHERE id=?").run(lost ? "lost" : "finished", id);
      this.db.prepare("UPDATE commands SET result='unknown' WHERE execution=? AND result='accepted'").run(id);
    }).immediate();
  }
  enqueue(execution: string, id: string, input: ExecutionCommand): ExecutionCommandResult {
    const body = JSON.stringify(ExecutionCommandSchema.parse(input));
    return this.db.transaction(() => {
      const prior = this.command(execution, id);
      if (prior) {
        if (JSON.stringify(prior.body) !== body) throw new Error("Command identity was reused with different content");
        return prior.result;
      }
      const row = this.get(execution);
      if (row.state !== "running") return "rejected";
      if (input.kind === "answer") {
        const question = row.question ? JSON.parse(row.question) as { requestId: string } : undefined;
        if (question?.requestId !== input.answer.requestId) return "rejected";
        // Keep the question until delivery. An uncertain earlier write must
        // never be resent; a definite rejection permits an explicit new attempt.
        const pending = this.db.prepare(`SELECT 1 FROM commands WHERE execution=?
          AND json_extract(body,'$.kind')='answer' AND json_extract(body,'$.answer.requestId')=?
          AND result!='rejected' LIMIT 1`).get(execution, input.answer.requestId);
        if (pending) return "rejected";
      }
      this.db.prepare("INSERT INTO commands(execution,id,body,result) VALUES (?,?,?,'accepted')").run(execution, id, body);
      return "accepted";
    }).immediate();
  }
  command(execution: string, id: string): CommandRecord | undefined {
    const row = this.db.prepare("SELECT * FROM commands WHERE execution=? AND id=?").get(execution, id) as (Omit<CommandRecord, "body"> & { body: string }) | undefined;
    return row && { ...row, body: ExecutionCommandSchema.parse(JSON.parse(row.body)) };
  }
  pending(id: string): CommandRecord[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT id FROM commands WHERE execution=? AND result='accepted' AND claimed=0 ORDER BY rowid").all(id) as { id: string }[];
      for (const row of rows) this.db.prepare("UPDATE commands SET claimed=1 WHERE execution=? AND id=?").run(id, row.id);
      return rows.map((row) => this.command(id, row.id)!);
    }).immediate();
  }
  settle(execution: string, id: string, result: ExecutionCommandResult) {
    this.db.transaction(() => {
      const command = this.command(execution, id);
      if (!command || command.result !== "accepted") return;
      this.db.prepare("UPDATE commands SET result=? WHERE execution=? AND id=?").run(result, execution, id);
      if (command.body.kind === "answer" && result === "delivered") {
        const { answer } = command.body;
        this.clearQuestion(execution, answer.requestId);
        this.append(execution, { taskId: this.get(execution).taskId, kind: "status",
          payload: { subtype: "answer", ...answer } });
      }
    }).immediate();
  }
  private clearQuestion(execution: string, requestId: string) {
    this.db.prepare("UPDATE executions SET question=NULL WHERE id=? AND json_extract(question,'$.requestId')=?")
      .run(execution, requestId);
  }
}
