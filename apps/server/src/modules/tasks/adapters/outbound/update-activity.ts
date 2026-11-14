import Database from "better-sqlite3";

/** Read-only activity snapshot for the legacy updater's admission check. */
export function legacyUpdateTasksIdle(database: string): boolean {
  const db = new Database(database, { readonly: true, fileMustExist: true });
  try { return (db.prepare("SELECT count(*) AS count FROM tasks WHERE status IN ('running','awaiting_approval','awaiting_input','queued')").get() as { count: number }).count === 0; }
  finally { db.close(); }
}
