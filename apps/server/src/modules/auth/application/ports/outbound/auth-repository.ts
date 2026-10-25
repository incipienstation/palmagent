import type { StoredCredential } from "../../../domain/credential.js";

export interface AuthRepository {
  transaction<T>(work: () => T): T;
  countCredentials(): number;
  getSession(token: string): { token: string; createdAt: number; expiresAt: number } | undefined;
  deleteSession(token: string): void;
  revokeSessions(): void;
  deleteCredential(credentialId: string): boolean;
  createSession(token: string, createdAt: number, expiresAt: number, label?: string): void;
  getEnrollToken(token: string, now: number): { sessionToken?: string } | undefined;
  listCredentials(): StoredCredential[];
  consumeEnrollToken(token: string, now: number): boolean;
  insertCredential(credential: StoredCredential): void;
  getCredential(id: string): StoredCredential | undefined;
  bumpCredentialCounter(id: string, counter: number, lastUsedAt: number): void;
  createEnrollToken(token: string, expiresAt: number, sessionToken?: string): void;
}
