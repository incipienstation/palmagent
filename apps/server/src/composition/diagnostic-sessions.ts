import Database from "better-sqlite3";
import { SqliteAuth } from "../modules/auth/adapters/outbound/sqlite-auth.js";
import type { DiagnosticSessions } from "../modules/installation/application/ports/outbound/diagnostic-sessions.js";

export const diagnosticSessions: DiagnosticSessions = {
  open(path) {
    const db = new Database(path, { fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    const auth = new SqliteAuth(db);
    return {
      create: (token, createdAt, expiresAt, label) => auth.createSession(token, createdAt, expiresAt, label),
      delete: token => auth.deleteSession(token),
      close: () => db.close(),
    };
  },
};
