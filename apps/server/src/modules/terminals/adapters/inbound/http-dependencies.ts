import type { HttpRuntime } from "../../../../platform/http/types.js";
import type { TerminalUseCases } from "../../application/ports/inbound/terminal-use-cases.js";
import type { SessionAccess } from "../../../../platform/http/types.js";
export interface HttpDependencies extends HttpRuntime {
 terminals?: Pick<TerminalUseCases, "list" | "capabilities" | "create" | "getPublic" | "rename" | "terminate">;
 terminalTickets?: { issue(token: string, id: string): { ticket: string; protocol: number } };
 auth: SessionAccess;
}
