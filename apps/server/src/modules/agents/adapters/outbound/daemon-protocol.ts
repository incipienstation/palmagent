// Wire protocol between the web server (DaemonBackend) and the runner daemon.
// Newline-delimited JSON over a Unix-domain socket.
import { BRANDING } from "@palmagent/shared";

// ---- web -> daemon ----
export type ClientMsg =
  | { t: "hello" }
  | { t: "start"; turnId: string; command: string; argv: string[]; cwd: string; env?: Record<string, string> }
  | { t: "attach"; turnId: string; fromSeq: number }
  | { t: "stdin"; turnId: string; data: string }
  | { t: "closeStdin"; turnId: string }
  | { t: "signal"; turnId: string; signal: NodeJS.Signals }
  | { t: "release"; turnId: string };

// ---- daemon -> web ----
export type ServerMsg =
  | { t: "live"; turns: string[] }
  | { t: "line"; turnId: string; seq: number; line: string }
  | { t: "stderr"; turnId: string; text: string }
  | { t: "exit"; turnId: string; code: number | null };

export const DEFAULT_RUNNER_SOCKET = `/run/${BRANDING.stateDirName}/runner.sock`;
