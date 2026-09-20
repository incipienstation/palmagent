import { TerminalStore } from "../terminal/store.js";
import { TERMINAL_PROTOCOL } from "@palmagent/shared/terminals";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, statSync, cpSync, copyFileSync, existsSync, readFileSync, renameSync, chmodSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import type { InstallConfig } from "./config.js";
import { ensurePrivateDirectory } from "../private-files.js";
import { run } from "./sh.js";
import { ExecutionStore } from "../execution/store.js";
import { EXECUTION_PROTOCOL } from "@palmagent/shared/executions";

export interface ReleaseContract { executionProtocol: number; productStorage: number; applicationApi: number; terminalProtocol?: number }
export function releaseContract(directory: string): ReleaseContract {
  const contract = JSON.parse(readFileSync(join(directory, "runtime-contract.json"), "utf8"));
  if (contract.executionProtocol !== EXECUTION_PROTOCOL || contract.productStorage !== 1 || contract.applicationApi !== 1) throw new Error("Candidate runtime or storage contract is incompatible");
  if (contract.terminalProtocol !== undefined && contract.terminalProtocol !== TERMINAL_PROTOCOL) throw new Error("Candidate terminal protocol is incompatible");
  for (const file of ["cli.js", "server.js", "execution-host.js", "execution-launcher.js"]) {
    if (!existsSync(join(directory, file))) throw new Error("Candidate release is incomplete");
  }
  if (contract.terminalProtocol === TERMINAL_PROTOCOL) {
    for (const file of ["terminal-host.js", "terminal-launcher.js"]) {
      if (!existsSync(join(directory, file))) throw new Error("Candidate terminal runtime is incomplete");
    }
  }
  return contract;
}
export function pinNode(dataDir: string): string {
  const hash = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
  const directory = join(dataDir, "runtimes", hash);
  ensurePrivateDirectory(directory);
  const node = join(directory, "node");
  if (!existsSync(node)) { copyFileSync(process.execPath, `${node}.tmp`); chmodSync(`${node}.tmp`, 0o700); renameSync(`${node}.tmp`, node); }
  if (createHash("sha256").update(readFileSync(node)).digest("hex") !== hash) throw new Error("Retained Node runtime integrity mismatch");
  return node;
}
/** First activation snapshots the installed global package before any executions
 * reference it. Future updates stage a new tree rather than overwriting this one. */
export function retainInstalledRelease(cfg: InstallConfig): void {
  if (cfg.mode !== "package" || cfg.executionNode || !cfg.pkgDir || !existsSync(join(cfg.pkgDir, "runtime-contract.json"))) return;
  releaseContract(cfg.pkgDir);
  const directory = join(cfg.dataDir, "releases", randomUUID());
  ensurePrivateDirectory(directory);
  cpSync(cfg.pkgDir, join(directory, "palmagent"), { recursive: true, dereference: true });
  cfg.pkgDir = join(directory, "palmagent");
  cfg.workingDir = cfg.pkgDir;
  cfg.executionNode = pinNode(cfg.dataDir);
}
export function stageRelease(cfg: InstallConfig, version: string): InstallConfig {
  const directory = join(cfg.dataDir, "releases", randomUUID());
  ensurePrivateDirectory(directory);
  // npm verifies the registry tarball integrity and assembles native dependencies
  // in a new prefix. Never mutate a release referenced by an existing execution.
  // Resolve npm before pinning Node on PATH: otherwise selecting Node may also
  // select a different npm installation (and bypass an operator's wrapper).
  const npm = (process.env.PATH ?? "").split(delimiter).map(directory => resolve(directory, "npm")).find(path => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  });
  if (!npm) throw new Error("npm is unavailable on the installation PATH");
  const result = run(npm, ["install", "--prefix", directory, "--omit=dev", "--no-audit", "--no-fund", `palmagent@${version}`], { timeout: 20 * 60_000, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` } });
  if (!result.ok) throw new Error("Could not stage the requested release");
  const pkgDir = join(directory, "node_modules", "palmagent");
  if (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version !== version) throw new Error("Staged package version differs from the requested release");
  releaseContract(pkgDir);
  const candidate = { ...cfg, pkgDir, workingDir: pkgDir, executionNode: pinNode(cfg.dataDir) };
  verifyActiveExecutionCompatibility(candidate);
  writeFileSync(join(directory, "release.json"), JSON.stringify({ version, package: pkgDir, runtime: candidate.executionNode, contract: releaseContract(pkgDir) }) + "\n", { mode: 0o600 });
  return candidate;
}
export function verifyActiveExecutionCompatibility(cfg: InstallConfig): void {
  if (!cfg.executionNode || !cfg.pkgDir) throw new Error("Independent execution is not enabled");
  const contract = releaseContract(cfg.pkgDir);
  const terminalDirectory = join(cfg.dataDir, "terminals");
  if (existsSync(terminalDirectory)) {
    const terminals = new TerminalStore(terminalDirectory);
    try {
      for (const record of terminals.list().filter(r => ["starting", "running", "closing"].includes(r.state))) {
        if (contract.terminalProtocol !== TERMINAL_PROTOCOL || record.protocol !== contract.terminalProtocol ||
            !existsSync(record.node) || !existsSync(join(record.release, "terminal-host.js"))) throw new Error("Candidate cannot control a retained terminal");
      }
    } finally { terminals.close(); }
  }
  const directory = join(cfg.dataDir, "executions");
  if (!existsSync(directory)) return;
  const store = new ExecutionStore(directory);
  try {
    for (const record of store.list()) {
      if (record.protocol !== contract.executionProtocol) throw new Error("Candidate cannot replay or control a retained execution");
      if (["queued", "starting", "running"].includes(record.state) && (!existsSync(record.node) || !existsSync(join(record.release, "execution-host.js")))) throw new Error("An active execution artifact is unavailable");
    }
  } finally { store.close(); }
}

export function assertExecutionsFinished(cfg: InstallConfig): void {
  const terminalDirectory = join(cfg.dataDir, "terminals");
  if (existsSync(terminalDirectory)) {
    const terminals = new TerminalStore(terminalDirectory);
    try { if (terminals.list().some(r => ["starting", "running", "closing"].includes(r.state))) throw new Error("Close active terminals before removing the installation"); }
    finally { terminals.close(); }
  }
  const directory = join(cfg.dataDir, "executions");
  if (!cfg.executionNode || !existsSync(directory)) return;
  const store = new ExecutionStore(directory);
  try {
    if (store.list().some(record => ["queued", "starting", "running"].includes(record.state))) {
      throw new Error("Independent executions remain active; let them finish before removing the installation");
    }
  } finally { store.close(); }
}
