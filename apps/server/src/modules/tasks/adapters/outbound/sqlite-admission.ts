import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { AdmissionCommand, AdmissionInbox, AdmissionStatus } from "../../application/ports/outbound/admission-inbox.js";
import { ensurePrivateFile, ensurePrivateParent } from "../../../../platform/filesystem/private-files.js";
import { ApplicationError } from "../../../../kernel/errors.js";
import { dirname } from "node:path";

/** Separate database: the admission listener can append without opening Task state for writing. */
export class SqliteAdmissionInbox implements AdmissionInbox {
  private readonly db: Database.Database;
  private ownerGeneration?: number;
  constructor(path: string) {
    ensurePrivateParent(dirname(path));
    this.db = new Database(path);
    try {
      ensurePrivateFile(path);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.exec(`CREATE TABLE IF NOT EXISTS admissions (
        sequence INTEGER PRIMARY KEY, scope TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL,
        command TEXT, bytes INTEGER NOT NULL, result TEXT, completed_at INTEGER, UNIQUE(scope, request_id)
      ); CREATE INDEX IF NOT EXISTS pending_admissions ON admissions(sequence) WHERE result IS NULL;
        CREATE TABLE IF NOT EXISTS admission_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL)`);
    } catch (error) { this.db.close(); throw error; }
  }

  receive(command: AdmissionCommand, defer: boolean): AdmissionStatus | undefined {
    const scope = command.kind === "create" ? "create" : "message:" + command.taskId;
    const id = command.kind === "create" ? command.input.clientRequestId : command.input.clientMessageId;
    if (!id) return;
    const lookup = () => this.db.prepare("SELECT digest,result FROM admissions WHERE scope=? AND request_id=?")
      .get(scope, id) as { digest: string; result: string | null } | undefined;
    const pending = () => this.db.prepare("SELECT 1 FROM admissions WHERE result IS NULL LIMIT 1").get();
    if (!defer && !lookup() && !pending()) return;
    const json = JSON.stringify(command);
    const digest = createHash("sha256").update(json).digest("hex");
    return this.db.transaction((): AdmissionStatus | undefined => {
      const prior = lookup();
      if (prior) {
        if (prior.digest !== digest) throw new ApplicationError("conflict", "This request ID already has different content.");
        return prior.result ? JSON.parse(prior.result) : { state: "pending" };
      }
      if (!defer && !pending()) return;
      this.db.prepare("DELETE FROM admissions WHERE completed_at < ?").run(Date.now() - 7 * 86_400_000);
      const load = this.db.prepare("SELECT COUNT(*) AS count, SUM(bytes) AS bytes FROM admissions WHERE result IS NULL")
        .get() as { count: number; bytes: number | null };
      const bytes = Buffer.byteLength(json);
      if (load.count >= 256 || (load.bytes ?? 0) + bytes > 256 * 1024 * 1024)
        throw new ApplicationError("insufficient_storage", "Update inbox is full. Keep the draft and try again.");
      this.db.prepare("INSERT INTO admissions(scope,request_id,digest,command,bytes) VALUES(?,?,?,?,?)").run(scope, id, digest, json, bytes);
      return { state: "pending" };
    }).immediate();
  }
  status(scope: string, id: string): AdmissionStatus | undefined {
    const row = this.db.prepare("SELECT result FROM admissions WHERE scope=? AND request_id=?").get(scope, id) as { result: string | null } | undefined;
    return row && (row.result ? JSON.parse(row.result) : { state: "pending" });
  }
  /** Only the Task process holding runtime.lock can call this during startup. */
  acquireOwner() {
    const row = this.db.prepare(`INSERT INTO admission_owner VALUES(1,1)
      ON CONFLICT(singleton) DO UPDATE SET generation=generation+1 RETURNING generation`).get() as { generation: number };
    this.ownerGeneration = row.generation;
  }
  assertOwner() {
    const row = this.db.prepare("SELECT generation FROM admission_owner WHERE singleton=1").get() as { generation: number } | undefined;
    if (!row || row.generation !== this.ownerGeneration) throw new Error("Task admission ownership changed");
  }
  next() {
    const row = this.db.prepare("SELECT sequence,command FROM admissions WHERE result IS NULL ORDER BY sequence LIMIT 1").get() as { sequence: number; command: string } | undefined;
    return row && { sequence: row.sequence, command: JSON.parse(row.command) as AdmissionCommand };
  }
  finish(sequence: number, status: AdmissionStatus) {
    const result = this.db.prepare(`UPDATE admissions SET command=NULL, bytes=0, result=?, completed_at=?
      WHERE sequence=? AND result IS NULL AND (SELECT generation FROM admission_owner WHERE singleton=1)=?`)
      .run(JSON.stringify(status), Date.now(), sequence, this.ownerGeneration);
    if (result.changes !== 1) throw new Error("Admission owner could not commit its receipt");
  }
  close() { this.db.close(); }
}
