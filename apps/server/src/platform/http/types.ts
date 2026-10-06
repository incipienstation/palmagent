/** Transport runtime facts shared by HTTP middleware and route adapters. */
export interface HttpRuntime {
  config: { repoRoots: string[]; keepAliveMs: number; staticDir: string; cookieName: string };
  build?: { version: string; sourceCommit: string; dirty: boolean };
  shutdown?: AbortSignal;
}
export interface SessionAccess {
  readonly enabled: boolean;
  readonly origin: string;
  verifySession(token: string | undefined): boolean;
  sessionValid(token: string | undefined): boolean;
}
