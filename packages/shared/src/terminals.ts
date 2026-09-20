import { z } from "zod";

export const TERMINAL_PROTOCOL = 1;
export const TERMINAL_STARTUP_TIMEOUT_MS = 30_000;
export type TerminalStartError = "services_unavailable" | "launch_unconfirmed" | "startup_timeout" | "host_exited" | "initialization_failed";
export const TerminalId = z.string().uuid();
export const TerminalSize = z.object({ cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) });
export const CreateTerminal = TerminalSize.extend({
  requestId: z.string().uuid(),
  target: z.union([z.object({ taskId: z.string().min(1).max(200) }).strict(), z.object({ repoId: z.string().min(1).max(200) }).strict()]),
  title: z.string().trim().min(1).max(80).optional(),
}).strict();
export type CreateTerminalRequest = z.infer<typeof CreateTerminal>;
export const RenameTerminal = z.object({ title: z.string().trim().min(1).max(80) }).strict();
export const TerminalQuery = z.object({ taskId: z.string().optional(), repoId: z.string().optional() });
export type TerminalState = "starting" | "running" | "closing" | "exited" | "lost";
export interface TerminalSession {
  id: string; taskId?: string; repoId: string; title: string; initialCwd: string;
  state: TerminalState; createdAt: number; exitCode?: number; protocol: number; startError?: string; startErrorCode?: TerminalStartError;
}
export interface TerminalCapabilities { available: boolean; persistent: boolean; reason?: string }
export const TerminalClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("attach"), ticket: z.string().min(1).max(200), protocol: z.literal(1) }).strict(),
  z.object({ type: z.literal("input"), epoch: z.number().int().nonnegative(), data: z.string().max(16_384) }).strict(),
  TerminalSize.extend({ type: z.literal("resize"), epoch: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("claim-control") }).strict(),
  z.object({ type: z.literal("release-control") }).strict(),
  z.object({ type: z.literal("ack"), seq: z.number().int().nonnegative() }).strict(),
]);
export type TerminalInput = Exclude<z.infer<typeof TerminalClientFrame>, { type: "attach" }>;
/** Keep large pastes within the frame limit without splitting a Unicode pair. */
export function* terminalInputChunks(data: string): Generator<string> {
  while (data.length) {
    let length = Math.min(data.length, 16_384);
    const last = data.charCodeAt(length - 1);
    if (length < data.length && last >= 0xd800 && last <= 0xdbff) length--;
    yield data.slice(0, length);
    data = data.slice(length);
  }
}
export type TerminalFrame =
  | { type: "snapshot"; data: string; seq: number; cols: number; rows: number }
  | { type: "output"; data: string; seq: number }
  | { type: "resize"; cols: number; rows: number; seq: number }
  | { type: "control"; writable: boolean; epoch: number }
  | { type: "exit"; exitCode?: number }
  | { type: "error"; message: string };
