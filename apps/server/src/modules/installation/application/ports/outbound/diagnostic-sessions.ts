/** Authentication storage is supplied by composition, not accessed by operator scripts. */
export interface DiagnosticSessions {
  open(database: string): {
    create(token: string, createdAt: number, expiresAt: number, label: string): void;
    delete(token: string): void;
    close(): void;
  };
}
