export interface GitHubAppCredentials {
  clientId: string;
  clientSecret: string;
}

export interface GitHubIdentity {
  id: string;
  login: string;
}

export interface GitHubBinding extends GitHubAppCredentials {
  bindingKey: string;
  owner: GitHubIdentity | null;
  expiresAt: number | null;
}
