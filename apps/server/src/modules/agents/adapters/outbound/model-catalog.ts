import { resolve } from "node:path";
import { readNdjsonQuery } from "../../../../platform/process/ndjson-query.js";
import type { AgentKind, AgentModelCatalog, ModelCatalogEntry, ModelCatalogChoice } from "@palmagent/shared";
import type { ModelCatalog } from "../../application/ports/inbound/model-catalog.js";
import { claudeMetadataArgs } from "./claude-metadata.js";

export const MODEL_CATALOG_TTL_MS = 300_000;
export const MODEL_CATALOG_RETRY_MS = 30_000;
const DEFAULT_CHOICE: ModelCatalogChoice = { value: "default", label: "default" };

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim().replace(/[\t\r\n ]+/g, " ").slice(0, 160);
  return result || undefined;
}

function choice(value: unknown): ModelCatalogChoice | undefined {
  const result = text(value);
  return result ? { value: result, label: result } : undefined;
}

function effortChoices(value: unknown): ModelCatalogChoice[] {
  if (!Array.isArray(value)) return [DEFAULT_CHOICE];
  const choices: ModelCatalogChoice[] = [DEFAULT_CHOICE];
  const seen = new Set([DEFAULT_CHOICE.value]);
  for (const item of value.slice(0, 64)) {
    const row = record(item);
    const effort = choice(typeof item === "string" ? item : row.reasoningEffort ?? row.effort ?? row.value);
    if (effort && !seen.has(effort.value)) {
      seen.add(effort.value);
      choices.push(effort);
    }
  }
  return choices;
}

export function defaultModelCatalog(agent: AgentKind): AgentModelCatalog {
  return { agent, source: "default", fetchedAt: null, models: [{ ...DEFAULT_CHOICE, efforts: [DEFAULT_CHOICE] }] };
}

// App Server responses contain additional account- and product-specific fields.
// Keep this projection deliberately narrow: the browser only needs selectable
// values, and it must not receive provider metadata by accident.
export function parseCodexModelCatalog(value: unknown, fetchedAt = Date.now()): AgentModelCatalog {
  const root = record(value);
  const rows = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
  const models: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  let defaultModel: ModelCatalogEntry | undefined;

  for (const item of rows.slice(0, 128)) {
    const row = record(item);
    if (row.hidden === true) continue;
    const model = choice(row.model ?? row.id);
    if (!model || model.value === DEFAULT_CHOICE.value || seen.has(model.value)) continue;
    const projected = { ...model, efforts: effortChoices(row.supportedReasoningEfforts) };
    seen.add(model.value);
    models.push(projected);
    if (row.isDefault === true) defaultModel = projected;
  }
  if (!models.length) throw new Error("Codex model catalog is empty");

  const delegateEfforts = defaultModel?.efforts ?? [DEFAULT_CHOICE];
  return {
    agent: "codex",
    source: "runtime",
    fetchedAt,
    models: [{ ...DEFAULT_CHOICE, efforts: delegateEfforts }, ...models],
  };
}

// No prompt or turn is sent. Authentication remains inside the installed CLI.
export async function readCodexModelCatalog(home: string, timeoutMs = 15_000): Promise<unknown> {
  return readNdjsonQuery({
    command: "codex", args: ["app-server", "--listen", "stdio://"], env: { CODEX_HOME: home },
    directoryPrefix: "palmagent-codex-catalog-", timeoutMs,
    errors: { unavailable: "Codex CLI unavailable", channel: "Codex catalog channel closed",
      timeout: "Codex model catalog read timed out", tooLarge: "Codex model catalog response too large", exited: "Codex catalog CLI exited" },
    initialize: ({ send }) => send({ method: "initialize", id: 1, params: { clientInfo: { name: "palmagent", version: "1" }, capabilities: {} } }),
    receive(message, { send, finish }) {
      if (message.id === 1) {
        if (message.error) return finish(new Error("Codex catalog initialization failed"));
        send({ method: "initialized" });
        send({ method: "model/list", id: 2, params: { includeHidden: false } });
      } else if (message.id === 2) {
        finish(message.error ? new Error("Codex model catalog request failed") : undefined, message.result);
      }
    },
  });
}

export function parseClaudeModelCatalog(value: unknown, fetchedAt = Date.now()): AgentModelCatalog {
  const rows = record(value).models;
  if (!Array.isArray(rows)) throw new Error("Claude model catalog is unavailable");
  const models = new Map<string, ModelCatalogEntry>();
  for (const item of rows.slice(0, 128)) {
    const row = record(item);
    const id = text(row.value);
    if (!id || models.has(id)) continue;
    models.set(id, { value: id, label: text(row.displayName) ?? id,
      efforts: effortChoices(row.supportsEffort === false ? undefined : row.supportedEffortLevels) });
  }
  if (!models.size) throw new Error("Claude model catalog is empty");
  const delegated = models.get("default") ?? { ...DEFAULT_CHOICE, efforts: [DEFAULT_CHOICE] };
  models.delete("default");
  return { agent: "claude", source: "runtime", fetchedAt, models: [delegated, ...models.values()] };
}

export function readClaudeModelCatalog(home: string, timeoutMs = 15_000): Promise<unknown> {
  return readNdjsonQuery({
    command: "claude", args: claudeMetadataArgs, env: { CLAUDE_CONFIG_DIR: home },
    directoryPrefix: "palmagent-claude-catalog-", timeoutMs,
    errors: { unavailable: "Claude CLI unavailable", channel: "Claude catalog channel closed",
      timeout: "Claude model catalog read timed out", tooLarge: "Claude model catalog response too large", exited: "Claude catalog CLI exited" },
    initialize: ({ send }) => send({ type: "control_request", request_id: "catalog", request: { subtype: "initialize" } }),
    receive(message, { finish }) {
      if (message.type !== "control_response") return;
      const response = record(message.response);
      if (response.request_id === "catalog") finish(response.subtype === "success" ? undefined : new Error("Claude initialization failed"), response.response);
    },
  });
}

type CacheEntry = {
  catalog: AgentModelCatalog;
  expiresAt: number;
  initial: boolean;
  refreshing?: Promise<void>;
};

// One catalog per provider home. A successful value survives a temporary CLI
// failure and is served stale while one refresh runs in the background.
export class ModelCatalogService implements ModelCatalog {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private read: (agent: AgentKind, home: string) => Promise<unknown> = (agent, home) =>
      agent === "claude" ? readClaudeModelCatalog(home) : readCodexModelCatalog(home),
    private now: () => number = Date.now,
  ) {}

  get(agent: AgentKind, home: string): Promise<AgentModelCatalog> {
    const key = JSON.stringify([agent, resolve(home)]);
    const now = this.now();
    let entry = this.cache.get(key);
    if (!entry) {
      entry = { catalog: defaultModelCatalog(agent), expiresAt: 0, initial: true };
      this.cache.set(key, entry);
      entry.refreshing = this.refresh(agent, home, entry);
      return entry.refreshing.then(() => entry!.catalog);
    }
    if (entry.initial && entry.refreshing) return entry.refreshing.then(() => entry!.catalog);
    if (entry.expiresAt > now) return Promise.resolve(entry.catalog);
    if (!entry.refreshing) entry.refreshing = this.refresh(agent, home, entry);
    return Promise.resolve({ ...entry.catalog, source: entry.catalog.fetchedAt !== null ? "stale" : "default" });
  }

  private async refresh(agent: AgentKind, home: string, entry: CacheEntry): Promise<void> {
    try {
      const parse = agent === "claude" ? parseClaudeModelCatalog : parseCodexModelCatalog;
      const catalog = parse(await this.read(agent, home), this.now());
      entry.catalog = catalog;
      entry.expiresAt = this.now() + MODEL_CATALOG_TTL_MS;
    } catch {
      if (entry.catalog.fetchedAt !== null) entry.catalog = { ...entry.catalog, source: "stale" };
      entry.expiresAt = this.now() + MODEL_CATALOG_RETRY_MS;
    } finally {
      entry.initial = false;
      entry.refreshing = undefined;
    }
  }
}
