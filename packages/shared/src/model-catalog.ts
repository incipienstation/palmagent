import type { AgentKind } from "./events.js";

export type ModelCatalogSource = "runtime" | "stale" | "default";

export interface ModelCatalogChoice {
  value: string;
  label: string;
}

export interface ModelCatalogEntry extends ModelCatalogChoice {
  efforts: ModelCatalogChoice[];
}

export interface AgentModelCatalog {
  agent: AgentKind;
  source: ModelCatalogSource;
  fetchedAt: number | null;
  models: ModelCatalogEntry[];
}
