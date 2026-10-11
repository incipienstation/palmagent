import type Database from "better-sqlite3";

// A durable revision covers writes from every repository/connection, including
// Space deletion and native imports. Unrelated transcript events do not expire
// Usage totals, and rolled-back writes also roll back the revision.
export function initializeUsageRevision(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_usage_revision (
      id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO task_usage_revision (id, revision) VALUES (1, 0);
    CREATE TRIGGER IF NOT EXISTS task_usage_insert AFTER INSERT ON tasks BEGIN
      UPDATE task_usage_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS task_usage_delete AFTER DELETE ON tasks BEGIN
      UPDATE task_usage_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS task_usage_agent AFTER UPDATE OF agent ON tasks
    WHEN OLD.agent IS NOT NEW.agent BEGIN
      UPDATE task_usage_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS result_usage_insert AFTER INSERT ON events
    WHEN NEW.kind = 'result' BEGIN
      UPDATE task_usage_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS result_usage_delete AFTER DELETE ON events
    WHEN OLD.kind = 'result' BEGIN
      UPDATE task_usage_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS result_usage_update AFTER UPDATE OF kind, payload_json, task_id ON events
    WHEN OLD.kind = 'result' OR NEW.kind = 'result' BEGIN
      UPDATE task_usage_revision SET revision = revision + 1 WHERE id = 1;
    END;
  `);
}
