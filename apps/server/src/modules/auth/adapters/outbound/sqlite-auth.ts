import Database from "better-sqlite3";
import type { StoredCredential } from "../../domain/credential.js";

type CredentialRow = {
  credential_id: string; public_key: string; counter: number; transports: string | null;
  label: string | null; created_at: number; last_used_at: number | null;
};

function rowToCredential(r: CredentialRow): StoredCredential {
  return {
    credentialId: r.credential_id,
    publicKey: r.public_key,
    counter: r.counter,
    transports: r.transports ? (JSON.parse(r.transports) as string[]) : undefined,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

export class SqliteAuth {
constructor(private readonly db: Database.Database) {}
  transaction<T>(work: () => T): T { return this.db.transaction(work).immediate(); }
insertCredential(c: StoredCredential) {
    this.db.prepare(
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, transports, label, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      c.credentialId, c.publicKey, c.counter,
      c.transports ? JSON.stringify(c.transports) : null,
      c.label ?? null, c.createdAt, c.lastUsedAt ?? null,
    );
  }

getCredential(credentialId: string): StoredCredential | undefined {
    const row = this.db.prepare(`SELECT * FROM webauthn_credentials WHERE credential_id = ?`).get(credentialId) as
      | CredentialRow
      | undefined;
    return row && rowToCredential(row);
  }

listCredentials(): StoredCredential[] {
    return (this.db.prepare(`SELECT * FROM webauthn_credentials ORDER BY created_at`).all() as CredentialRow[]).map(
      rowToCredential,
    );
  }

countCredentials(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM webauthn_credentials`).get() as { n: number }).n;
  }

bumpCredentialCounter(credentialId: string, counter: number, lastUsedAt: number) {
    this.db.prepare(
      `UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?`,
    ).run(counter, lastUsedAt, credentialId);
  }

deleteCredential(credentialId: string): boolean {
    return this.db.prepare(`DELETE FROM webauthn_credentials WHERE credential_id = ?`).run(credentialId).changes > 0;
  }

createSession(token: string, createdAt: number, expiresAt: number, label?: string) {
    this.db.prepare(
      `INSERT INTO auth_sessions (token, created_at, expires_at, label) VALUES (?, ?, ?, ?)`,
    ).run(token, createdAt, expiresAt, label ?? null);
  }

getSession(token: string): { token: string; createdAt: number; expiresAt: number } | undefined {
    const row = this.db.prepare(`SELECT token, created_at, expires_at FROM auth_sessions WHERE token = ?`).get(token) as
      | { token: string; created_at: number; expires_at: number }
      | undefined;
    return row && { token: row.token, createdAt: row.created_at, expiresAt: row.expires_at };
  }

refreshSession(token: string, expiresAt: number) {
    this.db.prepare(`UPDATE auth_sessions SET expires_at = ? WHERE token = ?`).run(expiresAt, token);
  }

deleteSession(token: string) {
    this.db.prepare(`DELETE FROM auth_sessions WHERE token = ?`).run(token);
  }

pruneExpiredSessions(now: number) {
    this.db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= ?`).run(now);
  }

createEnrollToken(token: string, expiresAt: number) {
    this.db.prepare(`INSERT INTO enroll_tokens (token, expires_at, used_at) VALUES (?, ?, NULL)`).run(token, expiresAt);
  }

isEnrollTokenValid(token: string, now: number): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM enroll_tokens WHERE token = ? AND used_at IS NULL AND expires_at > ?`)
      .get(token, now);
    return !!row;
  }

consumeEnrollToken(token: string, now: number): boolean {
    return (
      this.db
        .prepare(`UPDATE enroll_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at > ?`)
        .run(now, token, now).changes > 0
    );
  }
}
