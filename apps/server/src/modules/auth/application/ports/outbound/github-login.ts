import type { GitHubAppCredentials, GitHubBinding, GitHubIdentity } from "../../../domain/github.js";

export interface GitHubBindings {
  read(slot: "active" | "pending"): GitHubBinding | undefined;
  save(slot: "active" | "pending", binding: GitHubBinding): void;
  clear(slot: "active" | "pending"): void;
}

export interface GitHubOAuth {
  authorize(clientId: string, callback: string, state: string, verifier: string): string;
  identify(app: GitHubAppCredentials, callback: string, code: string, verifier: string): Promise<GitHubIdentity>;
}
