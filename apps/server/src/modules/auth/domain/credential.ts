export interface StoredCredential {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  label?: string | null;
  createdAt: number;
  lastUsedAt?: number | null;
}
