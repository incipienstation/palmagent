import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountLimits, AgentKind, ClaudeAccountLimits, CodexAccountLimits, CodexLimitBucket, LimitWindow } from "@palmagent/shared";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const label = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : undefined;

function window(value: unknown, agent: AgentKind): LimitWindow | undefined {
  const row = record(value);
  const used = finite(agent === "claude" ? row.utilization : row.usedPercent);
  const usedPercent = used !== null && used <= 100 ? used : null;
  const reset = agent === "claude"
    ? typeof row.resets_at === "string" ? Date.parse(row.resets_at) : null
    : typeof row.resetsAt === "number" ? row.resetsAt * 1000 : null;
  const resetsAt = finite(reset) !== null && reset! <= 8_640_000_000_000_000 ? reset : null;
  return usedPercent === null && resetsAt === null ? undefined : { usedPercent, resetsAt };
}

// Project only quota fields. CLI responses can also contain account IDs,
// session history, or cost totals; none belong in this endpoint or its logs.
export function parseAccountLimits(agent: AgentKind, value: unknown, checkedAt: number): AccountLimits {
  const data = record(value);
  if (agent === "claude") {
    if (typeof data.rate_limits_available !== "boolean") throw new Error("Unsupported usage response");
    const result: ClaudeAccountLimits = { agent, checkedAt, state: "unavailable", modelLimits: [] };
    if (!data.rate_limits_available) return result;
    if (!data.rate_limits) throw new Error("Account limits could not be read");
    const limits = record(data.rate_limits);
    result.fiveHour = window(limits.five_hour, agent);
    result.sevenDay = window(limits.seven_day, agent);
    for (const [key, name] of [["seven_day_opus", "Opus"], ["seven_day_sonnet", "Sonnet"], ["seven_day_oauth_apps", "OAuth apps"]]) {
      const limit = window(limits[key], agent);
      if (limit) result.modelLimits.push({ name, window: limit });
    }
    if (Array.isArray(limits.model_scoped)) for (const item of limits.model_scoped.slice(0, 32)) {
      const row = record(item), name = label(row.display_name), limit = window(row, agent);
      if (name && limit) {
        // Prefer the current model-scoped projection if a legacy field repeats it.
        result.modelLimits = result.modelLimits.filter((entry) => entry.name !== name);
        result.modelLimits.push({ name, window: limit });
      }
    }
    const extra = record(limits.extra_usage);
    if (extra.is_enabled === true) result.extraUsage = { usedPercent: finite(extra.utilization) };
    if (result.fiveHour || result.sevenDay || result.modelLimits.length || result.extraUsage) result.state = "ready";
    return result;
  }
  if (!data.rateLimits && !data.rateLimitsByLimitId) throw new Error("Unsupported rate limits response");
  const result: CodexAccountLimits = { agent, checkedAt, state: "unavailable", buckets: [] };
  const entries = Object.entries(record(data.rateLimitsByLimitId));
  const fallback = record(data.rateLimits);
  if (!entries.length && data.rateLimits) entries.push([label(fallback.limitId) ?? "codex", fallback]);
  for (const [id, value] of entries.slice(0, 32)) {
    const row = record(value);
    const bucket: CodexLimitBucket = { id, name: label(row.limitName) ?? (id === "codex" ? "Codex" : id.slice(0, 100)) };
    for (const key of ["primary", "secondary"] as const) {
      const limit = window(row[key], agent);
      if (limit) bucket[key] = { ...limit, windowMinutes: finite(record(row[key]).windowDurationMins) };
    }
    const credits = record(row.credits);
    if (credits.unlimited === true || credits.hasCredits === true) {
      bucket.credits = { unlimited: credits.unlimited === true, balance: typeof credits.balance === "string" && /^\d{1,12}(\.\d{1,8})?$/.test(credits.balance) ? credits.balance : null };
    }
    if (bucket.primary || bucket.secondary || bucket.credits) result.buckets.push(bucket);
  }
  result.buckets.sort((a, b) => Number(b.id === "codex") - Number(a.id === "codex"));
  if (result.buckets.length) result.state = "ready";
  return result;
}

// No prompt/turn is sent. Authentication stays inside the installed CLI.
// Claude's get_usage is experimental; unsupported versions fail closed. Its
// skip_behaviors flag avoids scanning native transcripts for usage attribution.
export async function readCliAccountLimits(agent: AgentKind, home: string, timeoutMs = 15_000): Promise<unknown> {
  const cwd = await mkdtemp(join(tmpdir(), "palmagent-limits-"));
  try {
    return await new Promise((resolve, reject) => {
      const args = agent === "codex" ? ["app-server"] : [
        "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--settings", '{"disableAllHooks":true}', "--tools", "", "--disable-slash-commands", "--no-chrome",
      ];
      const child = spawn(agent, args, { cwd, env: { ...process.env, [agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: home }, stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32" });
      const stop = (signal: NodeJS.Signals) => {
        // CLI launchers can leave descendants holding stdout after the wrapper
        // exits. Bound the whole reader process group, never a task's process.
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* the reader has already exited */ }
      };
      let done = false, buffer = "", bytes = 0;
      let result: unknown, failure: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, value?: unknown) => {
        if (done) return;
        done = true; result = value; failure = error;
        clearTimeout(timer);
        child.stdin.end();
        stop("SIGTERM");
        killTimer = setTimeout(() => stop("SIGKILL"), 1000);
        killTimer.unref();
      };
      const timer = setTimeout(() => finish(new Error("Account limit read timed out")), timeoutMs);
      const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
      child.stdin.on("error", () => finish(new Error("Account limit channel closed")));
      child.on("error", () => { failure = new Error("Account limit CLI unavailable"); });
      child.on("close", () => {
        clearTimeout(timer); clearTimeout(killTimer);
        stop("SIGKILL");
        if (!done || failure) reject(failure ?? new Error("Account limit CLI exited"));
        else resolve(result);
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (done) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1_048_576) { finish(new Error("Account limit response too large")); return; }
        buffer += chunk;
        let end: number;
        while (!done && (end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message: Record<string, unknown>;
          try { message = record(JSON.parse(line)); } catch { continue; }
          if (agent === "codex") {
            if (message.id === 1) {
              if (message.error) { finish(new Error("CLI initialization failed")); return; }
              send({ method: "initialized" });
              send({ method: "account/rateLimits/read", id: 2 });
            } else if (message.id === 2) {
              finish(message.error ? new Error("Account limit request failed") : undefined, message.result);
            }
          } else if (message.type === "control_response") {
            const response = record(message.response);
            if (response.request_id === "limits") finish(response.subtype !== "success" ? new Error("Account limit request failed") : undefined, response.response);
          }
        }
      });
      send(agent === "claude"
        ? { type: "control_request", request_id: "limits", request: { subtype: "get_usage", skip_behaviors: true } }
        : { method: "initialize", id: 1, params: { clientInfo: { name: "palmagent", version: "1" } } });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// All sessions using the same provider home share one read, including failures.
// A five-minute cache avoids hammering account endpoints from multiple tabs.
export class AccountLimitReader {
  private cache = new Map<string, { expiresAt: number; value: Promise<AccountLimits> }>();
  constructor(private read = readCliAccountLimits, private now = Date.now) {}

  get(agent: AgentKind, home: string): Promise<AccountLimits> {
    const key = JSON.stringify([agent, home]), now = this.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    for (const [key, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(key);
    const value = this.read(agent, home).then((data) => parseAccountLimits(agent, data, this.now())).catch((): AccountLimits =>
      agent === "claude" ? { agent, state: "error", checkedAt: this.now(), modelLimits: [] }
        : { agent, state: "error", checkedAt: this.now(), buckets: [] });
    this.cache.set(key, { expiresAt: now + 300_000, value });
    return value;
  }
}
