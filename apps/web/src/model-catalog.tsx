import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { AgentKind, CodexModelCatalog, ModelCatalogChoice } from "@palmagent/shared";
import { api } from "./api";
import { useForegroundRefresh } from "./hooks/useForegroundRefresh";

export type CatalogSource = CodexModelCatalog["source"] | "static";

export interface AgentCatalog {
  source: CatalogSource;
  models: ModelCatalogChoice[];
  effortsByModel: Record<string, ModelCatalogChoice[]>;
}

const DEFAULT_OPTION = { value: "default", label: "default" };
const CLAUDE_EFFORTS = [DEFAULT_OPTION, ...["low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value }))];
const CLAUDE_MODELS = [DEFAULT_OPTION, ...["opus", "sonnet", "haiku"].map((value) => ({ value, label: value }))];
const CLAUDE_CATALOG: AgentCatalog = {
  source: "static",
  models: CLAUDE_MODELS,
  effortsByModel: Object.fromEntries(CLAUDE_MODELS.map((model) => [model.value, CLAUDE_EFFORTS])),
};
const DEFAULT_CODEX_CATALOG: AgentCatalog = {
  source: "default",
  models: [DEFAULT_OPTION],
  effortsByModel: { default: [DEFAULT_OPTION] },
};

function runtimeCatalog(value: CodexModelCatalog): AgentCatalog {
  return {
    source: value.source,
    models: value.models.map(({ value: model, label }) => ({ value: model, label })),
    effortsByModel: Object.fromEntries(value.models.map((model) => [model.value, model.efforts])),
  };
}

export function modelChoices(catalog: AgentCatalog, current?: string): ModelCatalogChoice[] {
  if (!current || catalog.models.some((model) => model.value === current)) return catalog.models;
  return [...catalog.models, { value: current, label: current }];
}

export function effortChoices(catalog: AgentCatalog, model: string, current?: string): ModelCatalogChoice[] {
  const choices = catalog.effortsByModel[model] ?? catalog.effortsByModel.default ?? [DEFAULT_OPTION];
  if (!current || choices.some((effort) => effort.value === current)) return choices;
  return [...choices, { value: current, label: current }];
}

export function selectableModel(catalog: AgentCatalog, model: string): string {
  return catalog.models.some((option) => option.value === model) ? model : "default";
}

export function selectableEffort(catalog: AgentCatalog, model: string, effort: string): string {
  return effortChoices(catalog, model).some((option) => option.value === effort) ? effort : "default";
}

const CatalogContext = createContext<AgentCatalog | null>(null);

export function ModelCatalogProvider({ children }: { children: ReactNode }) {
  const [codex, setCodex] = useState<AgentCatalog>(DEFAULT_CODEX_CATALOG);
  const load = useCallback(async () => {
    try {
      setCodex(runtimeCatalog(await api.modelCatalog()));
    } catch {
      // Default-only remains usable, and an already loaded runtime catalog is
      // retained until the server can refresh it successfully.
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useForegroundRefresh(() => { void load(); });
  return <CatalogContext.Provider value={codex}>{children}</CatalogContext.Provider>;
}

export function useAgentCatalog(agent: AgentKind): AgentCatalog {
  const codex = useContext(CatalogContext);
  return agent === "codex" ? codex ?? DEFAULT_CODEX_CATALOG : CLAUDE_CATALOG;
}
