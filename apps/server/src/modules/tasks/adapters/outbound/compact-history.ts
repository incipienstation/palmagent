import type Database from "better-sqlite3";
import { TOOL_CALL_SUMMARY_FIELDS, TOOL_RESULT_SUMMARY_FIELDS } from "@palmagent/shared";

// Keep the small projection separate from tool payload overflow pages. Native
// imports and other SQLite writers share these triggers, including on rollback.
export function initializeCompactHistory(db: Database.Database): void {
  const fields = (names: readonly string[]) => names.map(name => `'${name}'`).join(", ");
  const fieldsSummary = (row: string) => `(SELECT json_group_object(key, json(CASE type
      WHEN 'text' THEN json_quote(value) WHEN 'true' THEN 'true'
      WHEN 'false' THEN 'false' WHEN 'null' THEN 'null' ELSE value END))
    FROM json_each(CASE WHEN json_valid(${row}.payload_json) THEN
      CASE WHEN json_type(${row}.payload_json) = 'object' THEN ${row}.payload_json ELSE '{}' END
      ELSE '{}' END)
    WHERE (${row}.kind = 'tool_call' AND key IN (${fields(TOOL_CALL_SUMMARY_FIELDS)}))
       OR (${row}.kind = 'tool_result' AND key IN (${fields(TOOL_RESULT_SUMMARY_FIELDS)})))`;
  const summary = (row: string) => `json_patch(${fieldsSummary(row)}, CASE WHEN ${row}.kind = 'tool_call' AND json_valid(${row}.payload_json) THEN
    json_object('traceTitle', substr(COALESCE(
      CASE WHEN json_type(${row}.payload_json, '$.command') = 'text' THEN json_extract(${row}.payload_json, '$.command') END,
      CASE WHEN json_type(${row}.payload_json, '$.command') = 'array' THEN
        (SELECT group_concat(value, ' ') FROM json_each(${row}.payload_json, '$.command') WHERE type = 'text') END,
      CASE WHEN json_type(${row}.payload_json, '$.input.command') = 'text' THEN json_extract(${row}.payload_json, '$.input.command') END,
      CASE WHEN json_type(${row}.payload_json, '$.input.command') = 'array' THEN
        (SELECT group_concat(value, ' ') FROM json_each(${row}.payload_json, '$.input.command') WHERE type = 'text') END,
      CASE WHEN json_type(${row}.payload_json, '$.input.file_path') = 'text' THEN
        COALESCE(json_extract(${row}.payload_json, '$.name'), 'File') || ' ' || json_extract(${row}.payload_json, '$.input.file_path') END,
      CASE WHEN json_type(${row}.payload_json, '$.input.path') = 'text' THEN
        COALESCE(json_extract(${row}.payload_json, '$.name'), 'File') || ' ' || json_extract(${row}.payload_json, '$.input.path') END,
      CASE WHEN json_type(${row}.payload_json, '$.name') = 'text' THEN json_extract(${row}.payload_json, '$.name') END,
      'Tool'), 1, 160)) ELSE '{}' END)`;
  db.transaction(() => {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_compact_payloads'").get();
    db.exec("CREATE TABLE IF NOT EXISTS event_compact_version (version INTEGER NOT NULL)");
    const upgrade = (db.prepare("SELECT version FROM event_compact_version").get() as { version: number } | undefined)?.version !== 2;
    if (upgrade) db.exec("DROP TRIGGER IF EXISTS event_compact_insert; DROP TRIGGER IF EXISTS event_compact_update;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_compact_payloads (
        event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS event_compact_insert AFTER INSERT ON events
      WHEN NEW.kind IN ('tool_call', 'tool_result') BEGIN
        INSERT INTO event_compact_payloads (event_id, payload_json) VALUES (NEW.id, ${summary("NEW")});
      END;
      CREATE TRIGGER IF NOT EXISTS event_compact_update AFTER UPDATE OF kind, payload_json ON events
      WHEN OLD.kind IN ('tool_call', 'tool_result') OR NEW.kind IN ('tool_call', 'tool_result') BEGIN
        DELETE FROM event_compact_payloads WHERE event_id = OLD.id;
        INSERT INTO event_compact_payloads (event_id, payload_json)
          SELECT NEW.id, ${summary("NEW")} WHERE NEW.kind IN ('tool_call', 'tool_result');
      END;
    `);
    // Creation and backfill are one transaction: readers never see a partial
    // migration, and reopening an upgraded database does not scan its history.
    if (upgrade && exists) db.exec("DELETE FROM event_compact_payloads");
    if (!exists || upgrade) db.exec(`INSERT INTO event_compact_payloads (event_id, payload_json)
      SELECT e.id, ${summary("e")} FROM events e WHERE e.kind IN ('tool_call', 'tool_result')`);
    if (upgrade) db.exec("DELETE FROM event_compact_version; INSERT INTO event_compact_version VALUES (2)");
  }).immediate();
}
