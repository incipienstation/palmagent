import type { AgentEvent } from "@palmagent/shared";

// A deliberately restricted shell reader, never an evaluator. Only a final,
// foreground `gh pr create` command can own its output. Ambiguous shell syntax
// is unsupported: quoting a command, printing source, or running a script is
// not evidence that a PR was created.
function commands(source: string): string[][] | null {
  const result: string[][] = [];
  let words: string[] = [], word = "", active = false;
  let quote = "", delimiter = false;
  const heredocs: { end: string; tabs: boolean }[] = [];
  let tabs = false;
  const flush = () => {
    if (!active) return;
    if (delimiter) { heredocs.push({ end: word, tabs }); delimiter = false; }
    else words.push(word);
    word = ""; active = false;
  };
  const finish = () => { flush(); if (words.length) result.push(words); words = []; };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) { quote = ""; continue; }
      if (quote === '"' && (ch === "$" || ch === "`")) return null;
      if (quote === '"' && ch === "\\" && /[\\"$`\n]/.test(source[i + 1] ?? "")) {
        const next = source[++i]; if (next !== "\n") word += next;
      } else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; active = true; continue; }
    if (ch === "\\") { if (++i >= source.length) return null; if (source[i] !== "\n") { word += source[i]; active = true; } continue; }
    if (ch === "#" && !active) { while (i < source.length && source[i] !== "\n") i++; i--; continue; }
    if (ch === "\n") {
      finish();
      for (const doc of heredocs.splice(0)) {
        let found = false;
        while (i < source.length) {
          const start = i + 1, end = source.indexOf("\n", start);
          const line = source.slice(start, end < 0 ? source.length : end);
          i = end < 0 ? source.length : end;
          if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.end) { found = true; break; }
        }
        if (!found) return null;
      }
      continue;
    }
    if (/\s/.test(ch)) { flush(); continue; }
    if (source.startsWith("<<", i) && !source.startsWith("<<<", i)) {
      flush(); delimiter = true; i++; tabs = source[i + 1] === "-"; if (tabs) i++;
      continue;
    }
    if (source.startsWith("&&", i)) { finish(); i++; continue; }
    if (ch === ";") { finish(); continue; }
    // Redirection is only supported on preceding commands (e.g. a body file).
    if (ch === ">") { flush(); words.push(">"); continue; }
    if (/[|&<(){}$`]/.test(ch)) return null;
    word += ch; active = true;
  }
  if (quote || delimiter || heredocs.length) return null;
  finish();
  return result;
}

export function isPrCreate(command: string, depth = 0): boolean {
  if (depth > 2) return false;
  const parsed = commands(command);
  if (!parsed?.length) return false;
  // CLI adapters include the shell wrapper in command_execution.command.
  if (parsed.length === 1) {
    const [bin, flag, script, ...rest] = parsed[0];
    if (/^(?:.*\/)?(?:ba|z|da)?sh$/.test(bin) && /^-[il]*c$/.test(flag ?? "") && script && !rest.length) {
      return isPrCreate(script, depth + 1);
    }
  }
  // Reject control flow and definitions even when their last words look valid.
  const reserved = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "!", "eval", "exec", "exit", "return"]);
  if (parsed.some((part) => reserved.has(part[0]))) return false;
  const last = parsed.at(-1)!;
  if (last[0] !== "gh" && !last[0].endsWith("/gh")) return false;
  let offset = 1;
  if (last[offset] === "-R" || last[offset] === "--repo") offset += 2;
  if (last[offset] !== "pr" || last[offset + 1] !== "create") return false;
  const values = new Set(["-a", "--assignee", "-B", "--base", "-b", "--body", "-F", "--body-file", "-H", "--head", "-l", "--label", "-m", "--milestone", "-p", "--project", "--recover", "-r", "--reviewer", "-T", "--template", "-t", "--title", "-R", "--repo"]);
  const switches = new Set(["-d", "--draft", "-e", "--editor", "-f", "--fill", "--fill-first", "--fill-verbose", "--no-maintainer-edit"]);
  for (let i = offset + 2; i < last.length; i++) {
    const [flag, ...value] = last[i].split("=");
    if (values.has(flag)) { if (!value.length && ++i >= last.length) return false; }
    else if (!switches.has(flag) || (value.length && !["true", "false"].includes(value.join("=")))) return false;
  }
  // In particular, --web, --dry-run and --help do not create a PR.
  return true;
}

type Event = Pick<AgentEvent, "kind" | "payload" | "agent">;
type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue => v && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};

export interface PrEvidenceState { pending: string[]; legacy: boolean }

export class PrEvidence {
  private pending: Set<string>;
  private legacy: boolean;
  constructor(state?: PrEvidenceState) {
    this.pending = new Set(state?.pending ?? []);
    this.legacy = state?.legacy ?? false;
  }
  snapshot(): PrEvidenceState { return { pending: [...this.pending], legacy: this.legacy }; }

  accept(event: Event): string[] {
    const p = record(event.payload);
    if (event.kind === "result" || (event.kind === "status" && ["turn_started", "process_exit", "followup"].includes(String(p.subtype)))) {
      this.pending.clear(); this.legacy = false; return [];
    }
    const legacy = this.legacy;
    this.legacy = false; // Old anonymous Codex events must be directly adjacent.
    if (event.kind === "tool_call") {
      let input = p.input;
      if (typeof input === "string") { try { input = JSON.parse(input); } catch { input = undefined; } }
      const args = record(input);
      const command = p.command ?? args.command ?? args.cmd;
      const shell = ["bash", "Bash", "exec_command", "functions.exec_command"].includes(String(p.name));
      const qualifies = shell && typeof command === "string" && isPrCreate(command);
      if (typeof p.id === "string") {
        this.pending.delete(p.id);
        if (qualifies) {
          if (this.pending.size >= 256) this.pending.clear();
          this.pending.add(p.id);
        }
      } else this.legacy = qualifies && p.status === "completed";
      return [];
    }
    if (event.kind !== "tool_result") return [];
    const id = typeof p.tool_use_id === "string" ? p.tool_use_id : undefined;
    const matched = id ? this.pending.has(id) : legacy;
    if (!matched) return [];
    if (p.exit_code === null || p.status === "in_progress") return [];
    if (id) this.pending.delete(id);
    if (p.is_error === true || ("exit_code" in p && p.exit_code !== 0)) return [];
    // Claude's Bash result uses is_error; Codex uses exit_code. Imported Codex
    // results may carry the structured exec result as JSON in content.
    let output = p.output ?? p.content;
    if (typeof output === "string" && output.trim().startsWith("{")) {
      try {
        const wrapped = record(JSON.parse(output));
        if (wrapped.exit_code !== 0) return [];
        output = wrapped.output;
      } catch { return []; }
    } else if (!("exit_code" in p) && event.agent !== "claude") return [];
    if (Array.isArray(output)) output = output.map((b) => record(b).type === "text" ? record(b).text : "").join("\n");
    if (typeof output !== "string") return [];
    const lines = output.trim().split(/\r?\n/);
    const url = lines.at(-1)?.trim();
    return url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(url) ? [url] : [];
  }
}
