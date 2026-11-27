import type { GitHubAppCredentials, GitHubIdentity } from "../../../domain/github.js";

export interface HostLogin {
  status(): { passkeys: number; github: GitHubIdentity | null; pending: { verified: GitHubIdentity | null; expiresAt: number } | null };
  prepare(app: GitHubAppCredentials): { bindingKey: string; expiresAt: number };
  confirm(ownerId: string): void;
  remove(method: "github" | "passkey"): void;
  revokeSessions(): void;
}
