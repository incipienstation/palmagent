export type ModelCatalogSource = "runtime" | "stale" | "default";

export interface ModelCatalogChoice {
  value: string;
  label: string;
}

export interface CodexModelCatalogModel extends ModelCatalogChoice {
  efforts: ModelCatalogChoice[];
}

export interface CodexModelCatalog {
  agent: "codex";
  source: ModelCatalogSource;
  fetchedAt: number | null;
  models: CodexModelCatalogModel[];
}
