import { ClaudeRunner } from "./claude.js";
import { CodexRunner } from "./codex.js";
import type { AgentKind } from "@palmagent/shared";
import type { AgentRunner } from "./types.js";

const runners: Record<AgentKind, AgentRunner> = {
  claude: new ClaudeRunner(),
  codex: new CodexRunner(),
};

export function getRunner(agent: AgentKind): AgentRunner {
  const r = runners[agent];
  if (!r) throw new Error(`unknown agent: ${agent}`);
  return r;
}
