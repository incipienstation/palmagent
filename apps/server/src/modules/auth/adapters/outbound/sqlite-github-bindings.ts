import type Database from "better-sqlite3";
import type { GitHubBinding } from "../../domain/github.js";
import type { GitHubBindings } from "../../application/ports/outbound/github-login.js";

export class SqliteGitHubBindings implements GitHubBindings {
  constructor(private readonly db: Database.Database) {}
  read(slot: "active" | "pending"): GitHubBinding | undefined {
    const row = this.db.prepare(`SELECT client_id, client_secret, binding_key, owner_id, login, expires_at
      FROM auth_github WHERE slot = ?`).get(slot) as {
      client_id: string; client_secret: string; binding_key: string;
      owner_id: string | null; login: string | null; expires_at: number | null;
    } | undefined;
    if (row) return { clientId: row.client_id, clientSecret: row.client_secret, bindingKey: row.binding_key,
      owner: row.owner_id && row.login ? { id: row.owner_id, login: row.login } : null, expiresAt: row.expires_at };
  }
  save(slot: "active" | "pending", binding: GitHubBinding): void {
    this.db.prepare(`INSERT OR REPLACE INTO auth_github
      (slot, client_id, client_secret, binding_key, owner_id, login, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(slot, binding.clientId, binding.clientSecret, binding.bindingKey, binding.owner?.id ?? null,
        binding.owner?.login ?? null, binding.expiresAt);
  }
  clear(slot: "active" | "pending"): void {
    this.db.prepare("DELETE FROM auth_github WHERE slot = ?").run(slot);
  }
}
