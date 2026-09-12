import type { AgentKind } from "./events.js";

// Deliberately bounded adapter lanes. Widen only after checking the executable
// adapter contracts and native transcript fixtures for the new CLI lane.
export { default as AGENT_CLI_COMPATIBILITY } from "./agent-compatibility.json" with { type: "json" };
import AGENT_CLI_COMPATIBILITY from "./agent-compatibility.json" with { type: "json" };

export function compatibleAgentCli(agent: AgentKind, version: string): boolean {
  const parse = (value: string): number[] | undefined => /^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(Number) : undefined;
  const actual = parse(version);
  if (!actual) return false;
  const compare = (other: string) => {
    const target = parse(other)!;
    for (let i = 0; i < 3; i++) if (actual[i] !== target[i]) return actual[i] - target[i];
    return 0;
  };
  const lane = AGENT_CLI_COMPATIBILITY[agent];
  return compare(lane.minimum) >= 0 && compare(lane.exclusiveMaximum) < 0;
}
