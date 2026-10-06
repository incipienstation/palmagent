import Database from "better-sqlite3";
import { dirname } from "node:path";
import { ensurePrivateFile, ensurePrivateParent } from "../filesystem/private-files.js";
import { migrateSchema } from "./migrations/schema.js";
import { migrateEventData } from "./event-migrations.js";

/** One connection and write lock shared by feature repositories. */
export function openDatabase(path: string): Database.Database {
 ensurePrivateParent(dirname(path));
 const db = new Database(path);
 try {
  ensurePrivateFile(path);
  db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON");
  migrateSchema(db); migrateEventData(db);
  return db;
 } catch (error) { db.close(); throw error; }
}
