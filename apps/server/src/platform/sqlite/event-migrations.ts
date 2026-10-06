import type Database from "better-sqlite3";
import { LEGACY_TURN_RESULT_MISSING_MESSAGE, TURN_RESULT_MISSING } from "@palmagent/shared";

/** One-time, transactional backfills preserve event identity and history cursors. */
export function migrateEventData(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS data_migrations (name TEXT PRIMARY KEY)");
  db.transaction(() => {
    const name = "event-turn-result-missing-v1";
    if (db.prepare("SELECT 1 FROM data_migrations WHERE name = ?").get(name)) return;
    db.prepare(`UPDATE events SET payload_json = json_set(payload_json, '$.code', ?)
      WHERE kind = 'error' AND task_id IN (SELECT id FROM tasks WHERE agent = 'codex')
        AND CASE WHEN json_valid(payload_json) THEN
          json_type(payload_json) = 'object' AND json_type(payload_json, '$.code') IS NULL
          AND json_extract(payload_json, '$.message') = ? ELSE 0 END`).run(
      TURN_RESULT_MISSING, LEGACY_TURN_RESULT_MISSING_MESSAGE,
    );
    db.prepare("INSERT INTO data_migrations (name) VALUES (?)").run(name);
  }).immediate();
}
