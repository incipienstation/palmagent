import { useQuery } from "@tanstack/react-query";
import type { AgentKind, AgentModelCatalog, ModelCatalogChoice } from "@palmagent/shared";
import { modelCatalogQueryOptions } from "./client-queries";

export interface AgentCatalog {
  source: AgentModelCatalog["source"];
  models: ModelCatalogChoice[];
  effortsByModel: Record<string, ModelCatalogChoice[]>;
}

const DEFAULT_OPTION = { value: "default", label: "default" };
const DEFAULT_CATALOG: AgentCatalog = {
  source: "default",
  models: [DEFAULT_OPTION],
  effortsByModel: { default: [DEFAULT_OPTION] },
};

function runtimeCatalog(value: AgentModelCatalog): AgentCatalog {
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

export function useAgentCatalog(agent: AgentKind, taskId?: string, enabled = true): AgentCatalog {
  const { data } = useQuery({ ...modelCatalogQueryOptions(agent, taskId), enabled });
  return data?.agent === agent ? runtimeCatalog(data) : DEFAULT_CATALOG;
}

/** Selection transitions are shared; each form owns its storage and reset semantics. */
export function modelSelection(catalog: AgentCatalog, savedModel: string, savedEffort: string,
  saveModel: (value: string) => void, saveEffort: (value: string) => void, current?: { model?: string; effort?: string }) {
  // Until discovery returns, keep the user's explicit settings in the submitted request.
  if (catalog === DEFAULT_CATALOG) return { model: savedModel, effort: savedEffort, setModel: saveModel };
  const model = current?.model === savedModel ? savedModel : selectableModel(catalog, savedModel);
  const effort = current && model === (current.model ?? "default") && current.effort === savedEffort
    ? savedEffort : selectableEffort(catalog, model, savedEffort);
  return { model, effort, setModel(value: string) {
    saveModel(value);
    saveEffort(selectableEffort(catalog, value, effort));
  } };
}
