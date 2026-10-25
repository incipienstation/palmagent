import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateSchema } from "../../../src/platform/sqlite/migrations/schema.js";

test("legacy unbound enrollment links are invalidated once, while new links survive restart", t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE enroll_tokens(token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER)");
  db.prepare("INSERT INTO enroll_tokens VALUES (?, ?, NULL)").run("legacy", Date.now() + 60000);
  migrateSchema(db);
  assert.deepEqual(db.prepare("SELECT * FROM enroll_tokens").all(), []);
  db.prepare("INSERT INTO enroll_tokens VALUES (?, ?, NULL, ?)").run("new", Date.now() + 60000, "issuer");
  migrateSchema(db);
  assert.deepEqual(db.prepare("SELECT token, session_token FROM enroll_tokens").all(), [{ token: "new", session_token: "issuer" }]);
});
