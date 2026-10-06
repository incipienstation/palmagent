import type { StoredCredential } from "../../../domain/credential.js";

export interface AuthRepository {
  transaction<T>(work: () => T): T;
  countCredentials(): number;
  getSession(token: string): { token: string; createdAt: number; expiresAt: number } | undefined;
  deleteSession(token: string): void;
  refreshSession(token: string, expiresAt: number): void;
  createSession(token: string, createdAt: number, expiresAt: number, label?: string): void;
  isEnrollTokenValid(token: string, now: number): boolean;
  listCredentials(): StoredCredential[];
  consumeEnrollToken(token: string, now: number): boolean;
  insertCredential(credential: StoredCredential): void;
  getCredential(id: string): StoredCredential | undefined;
  bumpCredentialCounter(id: string, counter: number, lastUsedAt: number): void;
  createEnrollToken(token: string, expiresAt: number): void;
}
