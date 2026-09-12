// Small shell/util helpers for the orchestration CLI: command execution, tool
// discovery, sudo-aware file writes, colored logging, and an interactive prompt.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command, capturing output. Never throws — inspect `.ok`. */
export function run(
  cmd: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): RunResult {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    input: opts.input,
    env: opts.env ?? process.env,
    timeout: opts.timeout,
  });
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? "").toString(),
  };
}

/** Absolute path of a tool on PATH, or undefined. */
export function which(tool: string): string | undefined {
  const r = run("bash", ["-lc", `command -v ${tool}`]);
  const p = r.stdout.trim();
  return r.ok && p ? p : undefined;
}

/** True if we can run sudo without an interactive password prompt. */
export function canSudoNonInteractive(): boolean {
  return run("sudo", ["-n", "true"]).ok;
}

/** Atomically replace a root-owned file. The candidate is installed beside the
 * destination, then renamed over it so readers never observe a partial file. */
export function sudoWriteFile(
  path: string,
  content: string,
  mode = "644",
): boolean {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-install-"));
  const local = join(dir, "candidate");
  const staged = `${path}.palmagent-${process.pid}.tmp`;
  try {
    writeFileSync(local, content, { mode: 0o600 });
    const installed = sudo(["install", "-m", mode, local, staged]);
    if (!installed.ok) return false;
    const moved = sudo(["mv", "-f", staged, path]);
    if (!moved.ok) sudo(["rm", "-f", staged]);
    return moved.ok;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run a privileged command (sudo). Returns the result. */
export function sudo(args: string[]): RunResult {
  return run("sudo", [...(process.env.PALMAGENT_NON_INTERACTIVE === "1" ? ["-n"] : []), ...args]);
}

// ---- logging ----
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
export const log = {
  info: (m: string) => console.log(`  ${m}`),
  step: (m: string) => console.log(paint("36;1", `\n▶ ${m}`)),
  ok: (m: string) => console.log(`  ${paint("32", "✓")} ${m}`),
  warn: (m: string) => console.log(`  ${paint("33", "!")} ${m}`),
  err: (m: string) => console.error(`  ${paint("31", "✗")} ${m}`),
  plain: (m: string) => console.log(m),
};

/** Interactive yes/no. In non-interactive contexts, returns `def`. */
export async function confirm(question: string, def = true): Promise<boolean> {
  if (!process.stdin.isTTY) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(`${question} ${def ? "[Y/n]" : "[y/N]"} `))
      .trim()
      .toLowerCase();
    if (!ans) return def;
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

/** Interactive free-text prompt with a default. */
export async function ask(question: string, def: string): Promise<string> {
  if (!process.stdin.isTTY) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (
      await rl.question(`${question}${def ? ` [${def}]` : ""}: `)
    ).trim();
    return ans || def;
  } finally {
    rl.close();
  }
}

export { execFileSync };
