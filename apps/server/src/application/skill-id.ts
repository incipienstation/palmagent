import { createHash } from "node:crypto";
import type { AgentKind } from "@palmagent/shared";

export function skillId(environment: { agent: AgentKind; home: string }, name: string, path?: string): string {
  return createHash("sha256").update(JSON.stringify([environment.agent, environment.home, name, path])).digest("hex");
}
