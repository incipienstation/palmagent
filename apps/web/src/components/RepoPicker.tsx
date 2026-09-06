import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DiscoveredRepo, FsListResponse, Repo, ValidateRepoPathResponse } from "@palmagent/shared";
import { ArrowUp, ChevronLeft, Folder, FolderSearch, GitBranch, Keyboard, RefreshCw, X } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { api, ApiError } from "../api";

// Mobile-first "Add a repo" picker (bottom drawer). Tap-first by design: the
// drawer opens keyboard-down showing discovered repos (zero typing for the
// common case), search is fuzzy so typos still match, out-of-root paths are
// reached by tap navigation (Browse), and manual path entry is the last
// resort — pre-validated live, with "did you mean" chips on failure.

const CACHE_KEY = "repoPicker.discover.v1";

type Mode = "search" | "browse" | "manual";

interface Props {
  open: boolean;
  repos: Repo[]; // registered repos — flags rows as added, enables remove
  onClose: () => void;
  onRegistered: (repo: Repo) => void;
  onChanged: () => void; // the registered set changed some other way (remove)
}

function errMsg(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : String(e);
}

// Substring matches score by position; otherwise an in-order subsequence match
// scores by spread. Lower = better, Infinity = no match.
function fuzzyScore(q: string, hay: string): number {
  const h = hay.toLowerCase();
  const idx = h.indexOf(q);
  if (idx >= 0) return idx;
  let last = -1;
  let gaps = 0;
  for (const ch of q) {
    const at = h.indexOf(ch, last + 1);
    if (at < 0) return Infinity;
    if (last >= 0) gaps += at - last - 1;
    last = at;
  }
  return 1000 + gaps;
}

// Display-only home abbreviation (server paths are linux or mac shaped).
function tilde(p: string): string {
  return p.replace(/^\/(home|Users)\/[^/]+/, "~");
}

// Truncates the head, keeps the leaf — the distinguishing part of a path.
// direction:rtl puts the ellipsis on the left; unicode-bidi:plaintext keeps
// the characters in logical order (otherwise the leading "~/" jumps to the end).
function PathText({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden font-mono text-xs text-ellipsis whitespace-nowrap text-muted-foreground [direction:rtl] [unicode-bidi:plaintext] text-left">
      {children}
    </div>
  );
}

function Row(props: {
  icon: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <div className={cn("flex items-center gap-1 border-b border-border pr-2.5", props.selected && "bg-accent")}>
      <button
        type="button"
        className="min-h-14 min-w-0 flex-1 px-3.5 py-2 text-left active:bg-accent disabled:opacity-55"
        onClick={props.onPress}
        disabled={props.disabled}
        role="option"
        aria-selected={props.selected ?? false}
      >
        <div className="flex items-center gap-2 font-semibold text-strong">
          <span aria-hidden="true" className="shrink-0 text-muted-foreground [&>svg]:size-4">
            {props.icon}
          </span>
          <span className="min-w-0 flex-1 truncate">{props.title}</span>
        </div>
        {props.sub && <PathText>{props.sub}</PathText>}
      </button>
      {props.trailing}
    </div>
  );
}

export function RepoPicker({ open, repos, onClose, onRegistered, onChanged }: Props) {
  const [mode, setMode] = useState<Mode>("search");
  const [query, setQuery] = useState("");
  const [discovered, setDiscovered] = useState<DiscoveredRepo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [browse, setBrowse] = useState<FsListResponse | null>(null);
  const [manualPath, setManualPath] = useState("");
  const [validation, setValidation] = useState<ValidateRepoPathResponse | null>(null);
  const [validating, setValidating] = useState(false);
  // branch is unset for a plain folder (no git) — registered/run in place.
  const [picked, setPicked] = useState<{ path: string; name: string; branch?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const debounceRef = useRef<number | undefined>(undefined);

  const registeredByPath = useMemo(() => new Map(repos.map((r) => [r.path, r])), [repos]);

  // Open: reset, render the cached scan instantly, revalidate in the background
  // (stale-while-revalidate — the drawer must answer before the network does).
  useEffect(() => {
    if (!open) return;
    setMode("search");
    setQuery("");
    setPicked(null);
    setValidation(null);
    setManualPath("");
    setError("");
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as { repos?: DiscoveredRepo[] } | null;
      if (cached?.repos) setDiscovered(cached.repos);
    } catch {
      /* stale/corrupt cache — scan will replace it */
    }
    void refresh(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function refresh(force: boolean) {
    setScanning(true);
    try {
      const out = await api.discoverRepos(force);
      setDiscovered(out.repos);
      localStorage.setItem(CACHE_KEY, JSON.stringify(out));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setScanning(false);
    }
  }

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return discovered;
    return discovered
      .map((r) => ({ r, s: Math.min(fuzzyScore(q, r.name), fuzzyScore(q, r.path)) }))
      .filter((x) => x.s !== Infinity)
      .sort((a, b) => a.s - b.s || b.r.lastActivityAt - a.r.lastActivityAt)
      .map((x) => x.r);
  }, [discovered, query]);

  // Browse/manual selections go through server validation; discovered rows are
  // already known-good so they confirm instantly. A non-git directory is still
  // pickable — it registers as a plain folder (tasks run in place).
  async function pickPath(path: string) {
    setError("");
    setValidating(true);
    setValidation(null);
    setPicked(null);
    try {
      const v = await api.validateRepoPath(path);
      setValidation(v);
      if (v.isGit && v.root) {
        setPicked({ path: v.root, name: v.root.split("/").pop() ?? v.root, branch: v.branch ?? "HEAD" });
      } else if (v.isDir) {
        setPicked({ path: v.resolved, name: v.resolved.split("/").pop() ?? v.resolved });
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setValidating(false);
    }
  }

  function onManualChange(v: string) {
    setManualPath(v);
    setPicked(null);
    setValidation(null);
    window.clearTimeout(debounceRef.current);
    if (!v.trim()) return;
    debounceRef.current = window.setTimeout(() => void pickPath(v), 350);
  }

  async function openBrowse(path?: string) {
    setMode("browse");
    setError("");
    try {
      setBrowse(await api.listFs(path));
    } catch (e) {
      setError(errMsg(e));
    }
  }

  async function register() {
    if (!picked) return;
    setBusy(true);
    setError("");
    try {
      onRegistered(await api.createRepo({ path: picked.path }));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeRepo(repo: Repo) {
    if (!window.confirm(`Remove "${repo.name}" from the dispatcher?`)) return;
    setError("");
    try {
      await api.deleteRepo(repo.id);
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent className="h-[min(86dvh,680px)]">
        <DrawerHeader>
          <div className="flex items-center gap-2">
            {mode !== "search" && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="-ml-1.5 text-blue"
                aria-label="Back to repo list"
                onClick={() => setMode("search")}
              >
                <ChevronLeft className="size-5" />
              </Button>
            )}
            <DrawerTitle>Add a repo</DrawerTitle>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => void refresh(true)}
              disabled={scanning}
              aria-label="Rescan repos"
            >
              <RefreshCw className={cn("size-3.5", scanning && "animate-spin")} />
            </Button>
            <Button variant="outline" size="icon-sm" onClick={onClose} aria-label="Close">
              <X className="size-3.5" />
            </Button>
          </div>
          <DrawerDescription className="sr-only">
            Pick a discovered repository, browse folders, or enter a path manually.
          </DrawerDescription>
          {mode === "search" && (
            <Input
              type="search"
              placeholder="Search repos…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              inputMode="search"
              enterKeyHint="search"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          )}
        </DrawerHeader>

        <div
          className="min-h-0 flex-1 overflow-y-auto pb-[calc(12px+var(--safe-bottom))]"
          role="listbox"
          aria-label="Repositories"
        >
          {error && (
            <Alert variant="destructive" className="mx-3.5 my-2.5 w-auto">
              {error}
            </Alert>
          )}

          {mode === "search" && (
            <>
              {results.map((r) => {
                const reg = registeredByPath.get(r.path);
                return (
                  <Row
                    key={r.path}
                    icon={<GitBranch />}
                    title={
                      <>
                        {r.name}
                        {reg && <span className="ml-2 text-[11px] font-medium text-green">✓ added</span>}
                      </>
                    }
                    sub={tilde(r.path)}
                    disabled={!!reg}
                    selected={picked?.path === r.path}
                    onPress={() => {
                      setError("");
                      setValidation(null);
                      setPicked({ path: r.path, name: r.name, branch: r.branch });
                    }}
                    trailing={
                      reg && (
                        <Button
                          variant="outline"
                          size="icon-sm"
                          className="border-destructive-border text-destructive"
                          aria-label={`Remove ${r.name}`}
                          onClick={() => void removeRepo(reg)}
                        >
                          <X className="size-3.5" />
                        </Button>
                      )
                    }
                  />
                );
              })}
              {results.length === 0 && !scanning && (
                <div className="px-6 py-12 text-center text-sm text-faint">
                  No repos match — try Browse or a manual path.
                </div>
              )}
              <Row icon={<FolderSearch />} title="Browse folders…" onPress={() => void openBrowse()} />
              <Row icon={<Keyboard />} title="Enter a path manually…" onPress={() => setMode("manual")} />
            </>
          )}

          {mode === "browse" && (
            <>
              <div className="px-3.5 pt-2.5 pb-1 font-mono text-xs break-all text-muted-foreground">
                {tilde(browse?.path ?? "")}
              </div>
              {browse?.parent && <Row icon={<ArrowUp />} title="Up" onPress={() => void openBrowse(browse.parent)} />}
              {browse?.root && (
                <Row
                  icon={<GitBranch />}
                  title="Select this repo"
                  sub={tilde(browse.root)}
                  onPress={() => void pickPath(browse.root ?? "")}
                />
              )}
              {browse && !browse.root && (
                <Row
                  icon={<Folder />}
                  title="Select this folder"
                  sub={`${tilde(browse.path)} · no git — tasks run in place`}
                  onPress={() => void pickPath(browse.path)}
                />
              )}
              {browse?.entries.map((e) => (
                <Row
                  key={e.path}
                  icon={e.isGitRepo ? <GitBranch /> : <Folder />}
                  title={e.name}
                  sub={e.isGitRepo ? "git repository · tap row to browse inside" : undefined}
                  onPress={() => void openBrowse(e.path)}
                  trailing={
                    e.isGitRepo && (
                      <Button
                        type="button"
                        variant="outline"
                        className="shrink-0"
                        aria-label={`Choose ${e.name} as repository`}
                        onClick={() => void pickPath(e.path)}
                      >
                        Choose
                      </Button>
                    )
                  }
                />
              ))}
              {browse && browse.entries.length === 0 && (
                <div className="px-6 py-12 text-center text-sm text-faint">No subfolders.</div>
              )}
            </>
          )}

          {mode === "manual" && (
            <div className="flex flex-col gap-2 px-3.5 py-3">
              <Label htmlFor="manual-path">Absolute path (or ~/…)</Label>
              <Input
                id="manual-path"
                className="font-mono"
                value={manualPath}
                onChange={(e) => onManualChange(e.target.value)}
                placeholder="~/code/my-repo"
                inputMode="text"
                enterKeyHint="done"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
              />
              {validating && <div className="text-[13px] text-muted-foreground">Checking…</div>}
              {validation && !validation.isDir && (
                <div className="text-[13px] text-destructive">
                  ✗ {validation.exists ? "Not a directory" : "No such directory"} — {tilde(validation.resolved)}
                </div>
              )}
              {validation && validation.isDir && !validation.isGit && (
                <div className="text-[13px] text-amber">
                  ⚠ No git here — registers as a plain folder (tasks run in place)
                </div>
              )}
              {validation && validation.isGit && validation.root && validation.root !== validation.resolved && (
                <div className="text-[13px] text-amber">⚠ Inside a repo — using its root {tilde(validation.root)}</div>
              )}
              {validation && !validation.isDir && validation.suggestions.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
                  Did you mean:
                  {validation.suggestions.map((s) => (
                    <Button
                      key={s}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="rounded-full font-mono font-normal text-blue"
                      onClick={() => {
                        setManualPath(s);
                        void pickPath(s);
                      }}
                    >
                      {tilde(s)}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {picked && (
          <DrawerFooter>
            <div>
              <div className="flex items-center gap-2 font-semibold text-strong">
                {picked.branch ? (
                  <GitBranch aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{picked.name}</span>
              </div>
              <PathText>{tilde(picked.path)}</PathText>
              <div className="mt-0.5 text-[13px] text-green">
                {picked.branch ? `✓ git repo · branch ${picked.branch}` : "✓ plain folder · tasks run in place"}
              </div>
            </div>
            <Button onClick={() => void register()} disabled={busy}>
              {busy ? "Registering…" : registeredByPath.has(picked.path) ? "Use this repo" : "Register"}
            </Button>
          </DrawerFooter>
        )}
      </DrawerContent>
    </Drawer>
  );
}
