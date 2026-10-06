import type { CodexModelCatalog } from "@palmagent/shared";

/** Operations accepted by the agents module. */
export interface ModelCatalog {
  get(home: string): Promise<CodexModelCatalog>;
}
