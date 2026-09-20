import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL_PROTOCOL, type TerminalSession } from "@palmagent/shared/terminals";
import { ensurePrivateDirectory, ensurePrivateFile } from "../private-files.js";

export interface TerminalRecord extends TerminalSession {
  requestId: string; release: string; node: string; directory: string;
  cols: number; rows: number; pid?: number; identity?: string;
}
const active = (record: TerminalRecord) => ["starting", "running", "closing"].includes(record.state);
export const publicTerminal = ({ id, taskId, repoId, title, initialCwd, state, createdAt, exitCode, protocol }: TerminalRecord): TerminalSession =>
  ({ id, taskId, repoId, title, initialCwd, state, createdAt, exitCode, protocol });

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
      if (this.list().filter(active).length >= 16) throw new Error("Close an existing terminal before opening another (limit: 16)");
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
      if (!record || record.state !== "starting" || record.pid) return false;
      this.update(id, { pid, identity, state: "running" });
      return true;
    }).immediate();
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
