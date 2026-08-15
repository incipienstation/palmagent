import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
  DiscoveredRepo,
  FsEntry,
  FsListResponse,
  Repo,
  ValidateRepoPathResponse,
} from "@palmagent/shared";
import { expandHome } from "./paths.js";
import { HttpError } from "./service.js";
import { detectDefaultBranch, gitToplevel } from "./worktree.js";

// Backs the PWA's tap-first "Add a repo" picker: scan the configured roots for
// git repos (so registering is a tap, not typing an absolute path on a phone),
// list directories for the drill-down browser, and pre-validate manual paths.
// Read-only throughout — registration still goes through TaskService.createRepo.

const SKIP_DIRS = new Set(["node_modules", ".git", ".palmagent", ".dispatcher", "dist", "build", "target"]);
const MAX_DEPTH = 4;
const CACHE_TTL_MS = 30_000;

type ScannedRepo = Omit<DiscoveredRepo, "repoId">;
let cache: { key: string; at: number; repos: ScannedRepo[] } | undefined;

// Scan results are cached briefly; `repoId` annotation happens per request (in
// annotate()) so registration changes show up without waiting out the TTL.
export function discoverRepos(roots: string[], force = false): { repos: ScannedRepo[]; scannedAt: number } {
  const key = roots.join(":");
  if (!force && cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    return { repos: cache.repos, scannedAt: cache.at };
  }
  const found: ScannedRepo[] = [];
  for (const root of roots) walk(root, 0, found);
  found.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  cache = { key, at: Date.now(), repos: found };
  return { repos: found, scannedAt: cache.at };
}

export function annotate(repos: ScannedRepo[], registered: Repo[]): DiscoveredRepo[] {
  const byPath = new Map(registered.map((r) => [r.path, r.id]));
  return repos.map((r) => {
    const repoId = byPath.get(r.path);
    return repoId ? { ...r, repoId } : r;
  });
}

function walk(dir: string, depth: number, out: ScannedRepo[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable / missing root — skip silently
  }
  if (entries.some((e) => e.name === ".git")) {
    out.push({ path: dir, name: basename(dir), branch: readHeadBranch(dir), lastActivityAt: activityAt(dir) });
    return; // a repo root — don't scan inside it for nested repos
  }
  if (depth >= MAX_DEPTH) return;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    walk(join(dir, e.name), depth + 1, out);
  }
}

// Read HEAD straight off disk: spawning `git` per repo would make the scan
// O(repos) subprocesses. Handles the gitfile indirection of linked worktrees.
function readHeadBranch(repoDir: string): string {
  try {
    let gitDir = join(repoDir, ".git");
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir: (.+)$/m.exec(readFileSync(gitDir, "utf8"));
      if (!m) return "HEAD";
      gitDir = resolve(repoDir, m[1].trim());
    }
    const m = /^ref: refs\/heads\/(.+)$/.exec(readFileSync(join(gitDir, "HEAD"), "utf8").trim());
    return m ? m[1] : "HEAD";
  } catch {
    return "HEAD";
  }
}

// mtime of .git/HEAD ≈ last checkout/commit — a cheap "recently worked on" proxy.
function activityAt(repoDir: string): number {
  for (const p of [join(repoDir, ".git", "HEAD"), repoDir]) {
    try {
      return statSync(p).mtimeMs;
    } catch {
      /* try next */
    }
  }
  return 0;
}

// ---- drill-down directory listing ----

export function defaultBrowseRoot(roots: string[]): string {
  return roots.find((r) => existsSync(r)) ?? homedir();
}

// Listing is confined to home + the configured roots. This is browse hygiene,
// not a security boundary (the authenticated owner can register any path via
// validate/create) — it just keeps the picker out of /etc and friends.
export function listDirectory(rawPath: string, roots: string[]): FsListResponse {
  const path = resolve(expandHome(rawPath.trim()));
  const allowed = [homedir(), ...roots];
  if (!allowed.some((r) => path === r || path.startsWith(r + sep))) {
    throw new HttpError(403, `browsing outside ${allowed.join(", ")} is not allowed`);
  }
  let dirents;
  try {
    dirents = readdirSync(path, { withFileTypes: true });
  } catch {
    throw new HttpError(404, `cannot list directory: ${path}`);
  }
  const entries: FsEntry[] = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP_DIRS.has(d.name))
    .map((d) => ({ name: d.name, path: join(path, d.name), isGitRepo: existsSync(join(path, d.name, ".git")) }))
    .sort((a, b) => Number(b.isGitRepo) - Number(a.isGitRepo) || a.name.localeCompare(b.name));
  const parent = dirname(path);
  const root = gitToplevel(path);
  return { path, ...(parent !== path ? { parent } : {}), ...(root ? { root } : {}), entries };
}

// ---- manual-path pre-validation (the confirm step's ✓/✗/did-you-mean) ----

export function validateRepoPath(input: string, roots: string[], registered: Repo[]): ValidateRepoPathResponse {
  const resolved = resolve(expandHome(input.trim()));
  const exists = existsSync(resolved);
  const isDir = exists && statSync(resolved).isDirectory();
  const root = isDir ? gitToplevel(resolved) : undefined;
  const res: ValidateRepoPathResponse = { input, resolved, exists, isDir, isGit: !!root, suggestions: [] };
  if (root) {
    res.root = root;
    res.branch = detectDefaultBranch(root);
    const reg = registered.find((r) => r.path === root);
    if (reg) res.repoId = reg.id;
  } else if (isDir) {
    // A plain directory is registrable as-is (vcs "none"); flag it registered
    // if it already is, and skip typo suggestions — the path resolves fine.
    const reg = registered.find((r) => r.path === resolved);
    if (reg) res.repoId = reg.id;
  } else {
    // Typo recovery: closest discovered repos by leaf-name edit distance,
    // surfaced as tappable "did you mean" chips instead of a dead-end error.
    const leaf = basename(resolved).toLowerCase();
    res.suggestions = discoverRepos(roots)
      .repos.map((r) => ({ path: r.path, d: levenshtein(leaf, r.name.toLowerCase()) }))
      .filter((x) => x.d <= Math.max(2, Math.floor(leaf.length / 2)))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map((x) => x.path);
  }
  return res;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
