import { openDatabase } from "../platform/sqlite/connection.js";
import { SqliteAuth } from "../modules/auth/adapters/outbound/sqlite-auth.js";
import { AuthService } from "../modules/auth/application/use-cases/auth-service.js";
import { webauthn } from "../modules/auth/adapters/outbound/webauthn.js";
import { config } from "./config.js";

export async function mintEnrollToken(path: string) {
  const db = openDatabase(path);
  try { return new AuthService(new SqliteAuth(db), config, webauthn).mintEnrollToken(); }
  finally { db.close(); }
}
