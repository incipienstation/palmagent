import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { RepositoryPathOperations } from "./application/ports.js";
import { expandHome } from "./paths.js";
import { detectDefaultBranch, gitToplevel } from "./worktree.js";

const exec = promisify(execFile);
function localGit(path: string, args: string[]): string {
  try { return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 2_000 }).trim(); }
  catch { return ""; }
}

/** Host filesystem and git adapter for repository registration. */
export class LocalRepositoryPaths implements RepositoryPathOperations {
  validBaseRef(path: string, baseRef: string): boolean {
    return !!baseRef && !baseRef.startsWith("-") && !/[\s\x00-\x1f]/.test(baseRef)
      && !!localGit(path, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]);
  }

  async defaultBaseRef(path: string): Promise<string> {
    const remotes = localGit(path, ["remote"]).split("\n").filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined;
    if (remote) {
      const usableBranch = (branch: string) => {
        if (this.validBaseRef(path, `refs/heads/${branch}`)) return branch;
        if (this.validBaseRef(path, `refs/remotes/${remote}/${branch}`)) return `${remote}/${branch}`;
        return undefined;
      };
      try {
        // Registration must not block the server or wait for credential prompts.
        const { stdout } = await exec("git", ["-C", path, "ls-remote", "--symref", "--", remote, "HEAD"], {
          encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
        });
        const branch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(stdout)?.[1];
        const base = branch && usableBranch(branch);
        if (base) return base;
      } catch { /* Offline/auth/timeout: use locally available information. */ }
      const cached = localGit(path, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
      const prefix = `refs/remotes/${remote}/`;
      const base = cached.startsWith(prefix) && usableBranch(cached.slice(prefix.length));
      if (base) return base;
    }
    // Local-only or ambiguous remotes: preserve a usable current checkout.
    return detectDefaultBranch(path);
  }

  inspect(input: string, defaultBaseRef?: string) {
    const requested = resolve(expandHome(String(input).trim()));
    const root = gitToplevel(requested);
    let isDirectory = false;
    try { isDirectory = statSync(requested).isDirectory(); } catch { /* missing or inaccessible */ }
    const path = root ?? requested;
    return {
      path,
      name: basename(path),
      exists: existsSync(requested),
      isDirectory,
      isGit: !!root,
      defaultBaseRef: root ? defaultBaseRef || detectDefaultBranch(root) : "",
    };
  }
}
