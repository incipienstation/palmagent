import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentKind, AvailableSkill, SkillCatalog, SkillSelection } from "@palmagent/shared";

export interface SkillEnvironment { agent: AgentKind; cwd: string; home: string }
const object = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const text = (v: unknown, max = 200) => typeof v === "string" ? v.slice(0, max) : "";

// Discovery never starts a turn. Do not execute hooks or connect project MCP
// servers just because somebody opens the picker. The native CLIs still own
// enabled plugins, project trust and user-invocable skill visibility.
export function readNativeSkills(env: SkillEnvironment, timeoutMs = 15_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const codex = env.agent === "codex";
    const child = spawn(env.agent, codex ? ["app-server"] : [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--settings", '{"disableAllHooks":true}',
    ], { cwd: env.cwd, env: { ...process.env, [codex ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: env.home }, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false, buffer = "", bytes = 0;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer);
      child.stdin.end(); child.kill("SIGTERM");
      const kill = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000); kill.unref();
      child.once("exit", () => clearTimeout(kill));
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("Skill discovery timed out. Try again.")), timeoutMs); timer.unref();
    const send = (v: unknown) => child.stdin.write(JSON.stringify(v) + "\n");
    child.stdin.on("error", () => finish(new Error("Skill discovery connection closed.")));
    child.on("error", () => finish(new Error(`${env.agent} is unavailable in this execution environment.`)));
    child.on("exit", () => finish(new Error("The agent exited before returning its skills.")));
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(data);
      if (bytes > 4_000_000) return finish(new Error("The skill catalogue is too large."));
      buffer += data.toString();
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let v: any; try { v = JSON.parse(line); } catch { continue; }
        if (codex && v.id === 1) {
          if (v.error) return finish(new Error("The installed Codex cannot discover skills."));
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "skills/list", params: { cwds: [env.cwd], forceReload: true } });
        } else if (codex && v.id === 2) {
          finish(v.error ? new Error("The installed Codex cannot list skills.") : undefined, v.result);
        } else if (!codex && v.type === "control_response" && v.response?.request_id === "skills") {
          finish(v.response.subtype === "error" ? new Error("The installed Claude cannot list skills.") : undefined, v.response.response);
        }
      }
    });
    send(codex ? { id: 1, method: "initialize", params: { clientInfo: { name: "palmagent", version: "1" } } }
      : { type: "control_request", request_id: "skills", request: { subtype: "initialize" } });
  });
}

export function parseNativeSkills(env: SkillEnvironment, value: unknown, claudePlugins: string[] = []): SkillCatalog {
  const data = object(value);
  const entry = env.agent === "codex" ? (Array.isArray(data.data) ? data.data.find((r: any) => r.cwd === env.cwd) : undefined) : undefined;
  const rows = env.agent === "codex" ? entry?.skills : data.commands;
  if (!Array.isArray(rows)) throw new Error("This agent version does not expose a skill catalogue.");
  const skills: AvailableSkill[] = [];
  for (const raw of rows) {
    const row = object(raw), name = text(row.name);
    if (!name || !/^[\p{L}\p{N}_.:/-]+$/u.test(name) || row.enabled === false || row.userInvocable === false) continue;
    const path = env.agent === "codex" ? text(row.path, 4096) : undefined;
    if (env.agent === "codex" && !path) continue;
    const pluginId = env.agent === "codex" ? text(row.pluginId) || undefined
      : claudePlugins.find(id => name.startsWith(`${id.split("@")[0]}:`));
    const source = pluginId?.split("@")[0] || (env.agent === "codex" ? text(row.scope) || "Codex" : "Claude");
    const id = skillId(env, name, path);
    skills.push({ id, name, source, ...(path ? { path } : {}), ...(pluginId ? { pluginId } : {}), description: text(row.description, 4000) });
  }
  return { skills: [...new Map(skills.map(s => [s.id, s])).values()].sort((a, b) => a.name.localeCompare(b.name)),
    ...(entry?.errors?.length ? { warning: "Some skills could not be loaded by the agent." } : {}) };
}

async function installedClaudePlugins(home: string): Promise<string[]> {
  try { return Object.keys(object(JSON.parse(await readFile(join(home, "plugins", "installed_plugins.json"), "utf8"))).plugins ?? {}); }
  catch { return []; }
}

// A bounded, short-lived cache coalesces picker requests only. Submission and
// execution re-check discovery so removed/disabled skills cannot run silently.
export class SkillDiscovery {
  private cache = new Map<string, { until: number; result: Promise<SkillCatalog> }>();
  constructor(private read = readNativeSkills) {}
  list(env: SkillEnvironment, fresh = false): Promise<SkillCatalog> {
    const key = JSON.stringify(env), cached = this.cache.get(key);
    if (!fresh && cached && cached.until > Date.now()) return cached.result;
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
    const result = Promise.all([this.read(env), env.agent === "claude" ? installedClaudePlugins(env.home) : []])
      .then(([raw, plugins]) => parseNativeSkills(env, raw, plugins));
    const entry = { until: Date.now() + 15_000, result }; this.cache.set(key, entry);
    void result.catch(() => { if (this.cache.get(key) === entry) this.cache.delete(key); });
    return result;
  }
  async resolve(env: SkillEnvironment, selected?: SkillSelection[], fresh = true): Promise<SkillSelection[] | undefined> {
    if (!selected?.length) return undefined;
    if (selected.length > 1) throw new Error("Choose one skill per message.");
    const catalog = await this.list(env, fresh);
    return selected.map(ref => {
      const found = catalog.skills.find(skill => skill.id === ref.id);
      if (!found) throw new Error("The selected skill is no longer available here. Remove it or choose it again.");
      const { description: _, ...skill } = found;
      return skill;
    });
  }
}

export function skillId(env: Pick<SkillEnvironment, "agent" | "home">, name: string, path?: string) {
  return createHash("sha256").update(JSON.stringify([env.agent, env.home, name, path])).digest("hex");
}
