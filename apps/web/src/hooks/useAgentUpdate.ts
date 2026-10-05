import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentInstallation } from "@palmagent/shared";
import { api } from "../api";
import { clientReadKeys } from "../client-query-keys";

export function useAgentUpdate(status?: AgentInstallation) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (!status?.version) throw new Error("Refresh the installed version before updating.");
      return api.updateAgent(status.agent, status.version);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: clientReadKeys.agentInstallations() });
      await client.invalidateQueries({ queryKey: clientReadKeys.modelCatalog() });
    },
    onError: () => { void client.invalidateQueries({ queryKey: clientReadKeys.agentInstallations() }); },
  });
}
