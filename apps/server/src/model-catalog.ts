import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import type { CodexModelCatalog, CodexModelCatalogModel, ModelCatalogChoice } from "@palmagent/shared";

const MAX_RESPONSE_BYTES = 1_048_576;
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

export function defaultCodexModelCatalog(): CodexModelCatalog {
  return { agent: "codex", source: "default", fetchedAt: null, models: [{ ...DEFAULT_CHOICE, efforts: [DEFAULT_CHOICE] }] };
}

// App Server responses contain additional account- and product-specific fields.
// Keep this projection deliberately narrow: the browser only needs selectable
// values, and it must not receive provider metadata by accident.
export function parseCodexModelCatalog(value: unknown, fetchedAt = Date.now()): CodexModelCatalog {
  const root = record(value);
  const rows = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
  const models: CodexModelCatalogModel[] = [];
  const seen = new Set<string>();
  let defaultModel: CodexModelCatalogModel | undefined;

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
  const cwd = await mkdtemp(join(tmpdir(), "palmagent-codex-catalog-"));
  try {
    return await new Promise((resolveResult, reject) => {
      const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
        cwd,
        env: { ...process.env, CODEX_HOME: home },
        stdio: ["pipe", "pipe", "ignore"],
        detached: process.platform !== "win32",
      });
      const stop = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* the reader has already exited */ }
      };
      let done = false;
      let buffer = "";
      let bytes = 0;
      let result: unknown;
      let failure: Error | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, value?: unknown) => {
        if (done) return;
        done = true;
        failure = error;
        result = value;
        if (timer) clearTimeout(timer);
        child.stdin.end();
        stop("SIGTERM");
        killTimer = setTimeout(() => stop("SIGKILL"), 1_000);
        killTimer.unref();
      };
      const send = (value: unknown) => {
        try { child.stdin.write(`${JSON.stringify(value)}\n`); }
        catch { finish(new Error("Codex catalog channel closed")); }
      };
      const handle = (message: Record<string, unknown>) => {
        if (message.id === 1) {
          if (message.error) return finish(new Error("Codex catalog initialization failed"));
          send({ method: "initialized" });
          send({ method: "model/list", id: 2, params: { includeHidden: false } });
        } else if (message.id === 2) {
          if (message.error) return finish(new Error("Codex model catalog request failed"));
          finish(undefined, message.result);
        }
      };
      child.stdin.on("error", () => finish(new Error("Codex catalog channel closed")));
      child.on("error", () => finish(new Error("Codex CLI unavailable")));
      child.on("close", () => {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        stop("SIGKILL");
        if (!done || failure) reject(failure ?? new Error("Codex catalog CLI exited"));
        else resolveResult(result);
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (done) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_RESPONSE_BYTES) return finish(new Error("Codex model catalog response too large"));
        buffer += chunk;
        let end: number;
        while (!done && (end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const message = record(JSON.parse(line));
            handle(message);
          } catch { /* ignore notifications and malformed lines until timeout */ }
        }
      });
      timer = setTimeout(() => finish(new Error("Codex model catalog read timed out")), timeoutMs);
      timer.unref();
      send({ method: "initialize", id: 1, params: { clientInfo: { name: "palmagent", version: "1" }, capabilities: {} } });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export interface CodexModelCatalogReader {
  get(home: string): Promise<CodexModelCatalog>;
}

type CacheEntry = {
  catalog: CodexModelCatalog;
  expiresAt: number;
  initial: boolean;
  refreshing?: Promise<void>;
};

// One catalog per provider home. A successful value survives a temporary CLI
// failure and is served stale while one refresh runs in the background.
export class CodexModelCatalogService implements CodexModelCatalogReader {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private read: (home: string) => Promise<unknown> = readCodexModelCatalog,
    private now: () => number = Date.now,
  ) {}

  get(home: string): Promise<CodexModelCatalog> {
    const key = resolve(home);
    const now = this.now();
    let entry = this.cache.get(key);
    if (!entry) {
      entry = { catalog: defaultCodexModelCatalog(), expiresAt: 0, initial: true };
      this.cache.set(key, entry);
      entry.refreshing = this.refresh(key, home, entry);
      return entry.refreshing.then(() => entry!.catalog);
    }
    if (entry.initial && entry.refreshing) return entry.refreshing.then(() => entry!.catalog);
    if (entry.expiresAt > now) return Promise.resolve(entry.catalog);
    if (!entry.refreshing) entry.refreshing = this.refresh(key, home, entry);
    return Promise.resolve({ ...entry.catalog, source: entry.catalog.source === "runtime" ? "stale" : "default" });
  }

  private async refresh(key: string, home: string, entry: CacheEntry): Promise<void> {
    try {
      const catalog = parseCodexModelCatalog(await this.read(home), this.now());
      entry.catalog = catalog;
      entry.expiresAt = this.now() + MODEL_CATALOG_TTL_MS;
    } catch {
      if (entry.catalog.source === "runtime") {
        entry.expiresAt = this.now() + MODEL_CATALOG_RETRY_MS;
      } else {
        entry.catalog = defaultCodexModelCatalog();
        entry.expiresAt = this.now() + MODEL_CATALOG_RETRY_MS;
      }
    } finally {
      entry.initial = false;
      if (this.cache.get(key) === entry) entry.refreshing = undefined;
    }
  }
}
