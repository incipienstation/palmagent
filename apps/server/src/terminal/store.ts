import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL_PROTOCOL, TERMINAL_STARTUP_TIMEOUT_MS, type TerminalSession, type TerminalStartError } from "@palmagent/shared/terminals";
import { ensurePrivateDirectory, ensurePrivateFile } from "../private-files.js";

export interface TerminalRecord extends TerminalSession {
  diagnostic?: boolean; diagnosticCleanupFailed?: boolean;
  requestId: string; release: string; node: string; directory: string;
  cols: number; rows: number; pid?: number; identity?: string;
}
const active = (record: TerminalRecord) => ["starting", "running", "closing"].includes(record.state);
export const publicTerminal = ({ id, taskId, repoId, title, initialCwd, state, createdAt, exitCode, protocol, startError, startErrorCode }: TerminalRecord): TerminalSession =>
  ({ id, taskId, repoId, title, initialCwd, state, createdAt, exitCode, protocol, startError, startErrorCode });

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
  }
  list(): TerminalRecord[] {
    return (this.db.prepare("SELECT record FROM terminals ORDER BY rowid DESC").all() as { record: string }[]).map(row => JSON.parse(row.record));
  }
  get(id: string): TerminalRecord | undefined {
    const row = this.db.prepare("SELECT record FROM terminals WHERE id = ?").get(id) as { record: string } | undefined;
    return row && JSON.parse(row.record);
  }
  reserve(input: Omit<TerminalRecord, "id" | "createdAt" | "state" | "protocol">): { record: TerminalRecord; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.list().find(record => record.requestId === input.requestId);
      if (existing) {
        if (existing.taskId !== input.taskId || existing.repoId !== input.repoId) throw new Error("Creation request already belongs to another target");
        return { record: existing, created: false };
      }
      const occupied = this.list().filter(record => active(record) && Boolean(record.diagnostic) === Boolean(input.diagnostic));
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
      if (this.list().some(record => active(record) && record.initialCwd === cwd)) {
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
