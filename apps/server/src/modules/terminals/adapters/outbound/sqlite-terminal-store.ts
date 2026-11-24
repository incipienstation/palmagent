import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { TERMINAL_PROTOCOL, TERMINAL_STARTUP_TIMEOUT_MS, type TerminalStartError } from "@palmagent/shared/terminals";
import { ensurePrivateDirectory, ensurePrivateFile } from "../../../../platform/filesystem/private-files.js";

import { active, type TerminalRecord } from "../../domain/terminal.js";
export { publicTerminal, type TerminalRecord } from "../../domain/terminal.js";

const activePredicate = "json_extract(record, '$.state') IN ('starting','running','closing')";

/** Stable registry shared by CLI, web, and pinned terminal hosts. No terminal bytes or input are persisted. */
export class TerminalStore {
  private db: Database.Database;
  constructor(readonly directory: string) {
    ensurePrivateDirectory(directory);
    const path = join(directory, "registry.sqlite");
    this.db = new Database(path);
    ensurePrivateFile(path);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS terminals (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cleanup (cwd TEXT PRIMARY KEY, task_id TEXT NOT NULL);");
    // Watch the public projection across all registry connections, including retained hosts.
    const visible = (row: string) => `(NOT coalesce(json_extract(${row}.record, '$.diagnostic'), 0)
      OR coalesce(json_extract(${row}.record, '$.diagnosticCleanupFailed'), 0))`;
    const publicFields = "'$.id','$.taskId','$.repoId','$.title','$.initialCwd','$.state','$.createdAt','$.exitCode','$.protocol','$.startError','$.startErrorCode'";
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS terminals_active ON terminals(id) WHERE ${activePredicate};
      CREATE TABLE IF NOT EXISTS terminal_revision (singleton INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO terminal_revision VALUES (1, 0);
      CREATE TRIGGER IF NOT EXISTS terminal_insert AFTER INSERT ON terminals WHEN ${visible("NEW")} BEGIN
        UPDATE terminal_revision SET revision = revision + 1;
      END;
      CREATE TRIGGER IF NOT EXISTS terminal_delete AFTER DELETE ON terminals WHEN ${visible("OLD")} BEGIN
        UPDATE terminal_revision SET revision = revision + 1;
      END;
      CREATE TRIGGER IF NOT EXISTS terminal_update AFTER UPDATE OF record ON terminals
      WHEN ${visible("OLD")} != ${visible("NEW")} OR
        (${visible("NEW")} AND json_extract(OLD.record, ${publicFields}) != json_extract(NEW.record, ${publicFields})) BEGIN
        UPDATE terminal_revision SET revision = revision + 1;
      END;
    `);
  }
  watch(changed: () => void): () => void {
    let scheduled: NodeJS.Immediate | undefined;
    const notify = () => { scheduled ??= setImmediate(() => { scheduled = undefined; changed(); }); };
    // Watch the directory: WAL files can be replaced by another host process.
    const watcher = watch(this.directory, (_event, name) => {
      if (name === null || name.startsWith("registry.sqlite")) notify();
    });
    watcher.on("error", notify);
    return () => { watcher.close(); if (scheduled) clearImmediate(scheduled); };
  }
  list(): TerminalRecord[] {
    return (this.db.prepare("SELECT record FROM terminals ORDER BY rowid DESC").all() as { record: string }[]).map(row => JSON.parse(row.record));
  }
  revision(): number {
    return this.db.prepare("SELECT revision FROM terminal_revision WHERE singleton = 1").pluck().get() as number;
  }
  activeRecords(): TerminalRecord[] {
    const rows = this.db.prepare(`SELECT record FROM terminals INDEXED BY terminals_active WHERE ${activePredicate} ORDER BY rowid DESC`).pluck().all() as string[];
    return rows.map(record => JSON.parse(record));
  }
  byRequest(requestId: string): TerminalRecord | undefined {
    const record = this.db.prepare("SELECT record FROM terminals WHERE request_id = ?").pluck().get(requestId) as string | undefined;
    return record === undefined ? undefined : JSON.parse(record);
  }
  get(id: string): TerminalRecord | undefined {
    const row = this.db.prepare("SELECT record FROM terminals WHERE id = ?").get(id) as { record: string } | undefined;
    return row && JSON.parse(row.record);
  }
  reserve(input: Omit<TerminalRecord, "id" | "createdAt" | "state" | "protocol">): { record: TerminalRecord; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.byRequest(input.requestId);
      if (existing) {
        if (existing.taskId !== input.taskId || existing.repoId !== input.repoId) throw new Error("Creation request already belongs to another target");
        return { record: existing, created: false };
      }
      const occupied = this.activeRecords().filter(record => Boolean(record.diagnostic) === Boolean(input.diagnostic));
      if (input.diagnostic && occupied.length) throw new Error("A terminal diagnostic is already active");
      if (!input.diagnostic && occupied.length >= 16) throw new Error("Close an existing terminal before opening another (limit: 16)");
      const cwd = realpathSync(input.initialCwd);
      if (!statSync(cwd).isDirectory()) throw new Error("Working directory is unavailable");
      if (this.db.prepare("SELECT cwd FROM cleanup WHERE cwd = ?").get(cwd)) throw new Error("Working directory is pending cleanup");
      const record: TerminalRecord = { ...input, initialCwd: cwd, id: randomUUID(), createdAt: Date.now(), state: "starting", protocol: TERMINAL_PROTOCOL };
      this.db.prepare("INSERT INTO terminals VALUES (?, ?, ?)").run(record.id, record.requestId, JSON.stringify(record));
      return { record, created: true };
    }).immediate();
  }
  update(id: string, change: Partial<TerminalRecord>): TerminalRecord {
    return this.db.transaction(() => {
      const record = this.get(id);
      if (!record) throw new Error("Terminal not found");
      const next = { ...record, ...change };
      this.db.prepare("UPDATE terminals SET record = ? WHERE id = ?").run(JSON.stringify(next), id);
      return next;
    }).immediate();
  }
  claim(id: string, pid: number, identity: string): boolean {
    return this.db.transaction(() => {
      const record = this.get(id);
      if (!record || record.state !== "starting" || record.pid || record.startErrorCode === "startup_timeout") return false;
      this.update(id, { pid, identity });
      return true;
    }).immediate();
  }
  ready(id: string, pid: number, identity: string): boolean {
    return this.db.transaction(() => {
      const record = this.get(id);
      if (!record || record.state !== "starting" || record.pid !== pid || record.identity !== identity ||
          record.startErrorCode === "startup_timeout") return false;
      if (this.expireStartup(id)) return false;
      this.update(id, { state: "running", startError: undefined, startErrorCode: undefined });
      return true;
    }).immediate();
  }
  noteStartError(id: string, code: TerminalStartError, message: string): void {
    this.db.transaction(() => {
      const record = this.get(id);
      if (record?.state === "starting" && record.startErrorCode !== "startup_timeout") {
        this.update(id, { startErrorCode: code, startError: message });
      }
    }).immediate();
  }
  /** Fence a late host under the same lock used by readiness. */
  expireStartup(id: string): boolean {
    return this.db.transaction(() => {
      const record = this.get(id);
      if (!record || !["starting", "closing"].includes(record.state)) return false;
      if (record.startErrorCode === "startup_timeout") return true;
      if (record.state !== "starting" || Date.now() - record.createdAt < TERMINAL_STARTUP_TIMEOUT_MS) return false;
      this.update(id, { startErrorCode: "startup_timeout", startError: "Shell startup timed out. Termination is being confirmed; open a new terminal after it stops." });
      return true;
    }).immediate();
  }
  removeDiagnostic(id: string): void {
    const record = this.get(id);
    if (!record?.diagnostic || active(record)) throw new Error("Diagnostic shell termination must be confirmed before cleanup");
    this.db.prepare("DELETE FROM terminals WHERE id = ?").run(id);
  }
  /** The reservation and deletion check share a write lock, including across processes. */
  cleanup(cwd: string, taskId: string, remove: () => void): boolean {
    if (existsSync(cwd)) cwd = realpathSync(cwd);
    return this.db.transaction(() => {
      if (this.activeRecords().some(record => record.initialCwd === cwd)) {
        this.db.prepare("INSERT OR REPLACE INTO cleanup VALUES (?, ?)").run(cwd, taskId);
        return false;
      }
      remove();
      this.db.prepare("DELETE FROM cleanup WHERE cwd = ?").run(cwd);
      return true;
    }).immediate();
  }
  pendingCleanup(): { cwd: string; taskId: string }[] {
    return this.db.prepare("SELECT cwd, task_id AS taskId FROM cleanup").all() as { cwd: string; taskId: string }[];
  }
  close() { this.db.close(); }
}
