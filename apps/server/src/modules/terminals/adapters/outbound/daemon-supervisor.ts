import { DaemonHostStateSchema, DaemonStatusSchema } from "@palmagent/shared/daemon";
import { daemonRequest } from "../../../../platform/process/daemon-client.js";
import type { TerminalSupervisor } from "../../application/ports/outbound/terminal-platform.js";

export function daemonTerminalSupervisor(dataDir: string): TerminalSupervisor {
  return {
    capabilities: { available: true, persistent: true },
    async inspect() { DaemonStatusSchema.parse(daemonRequest(dataDir, { action: "status" })); },
    async launch(record) { daemonRequest(dataDir, { action: "launch", kind: "terminal", id: record.id }); },
    async terminate(record) { daemonRequest(dataDir, { action: "terminate", kind: "terminal", id: record.id }); },
    async alive(record) {
      const state = DaemonHostStateSchema.parse(daemonRequest(dataDir, { action: "inspect", kind: "terminal", id: record.id }));
      // An ambiguous start retains its admission/worktree, exactly as the legacy supervisor does.
      return state.alive;
    },
  };
}
