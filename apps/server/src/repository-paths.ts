import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { RepositoryPathOperations } from "./application/ports.js";
import { expandHome } from "./paths.js";
import { detectDefaultBranch, gitToplevel } from "./worktree.js";

/** Host filesystem and git adapter for repository registration. */
export class LocalRepositoryPaths implements RepositoryPathOperations {
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
