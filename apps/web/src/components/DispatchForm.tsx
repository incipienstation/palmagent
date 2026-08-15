import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { AgentKind, Permission, Repo } from "@palmagent/shared";
import { Loader2, Plus, Send } from "lucide-react";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollBar } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toast } from "@/components/ui/toaster";
import { api, ApiError, DEFAULT_OPTION, DEFAULT_PERMISSION, EFFORTS, MODELS, PERMISSIONS } from "../api";
import { clearDraft, useDraft, usePersistedMapEntry, usePersistedString } from "../hooks/useDraft";
import { navigate } from "../router";
import { AppBar, AppShell } from "./AppShell";
import { AttachmentTray, useImageAttachments } from "./Attachments";
import { RepoPicker } from "./RepoPicker";

const AGENTS: AgentKind[] = ["claude", "codex"];

function errMsg(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : String(e);
}

// Section eyebrow — 11px/600 tracking-wide uppercase (§3.1). Labels each
// section card so the dense form reads as grouped fields, not one wall.
function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="px-1 text-[11px] leading-none font-semibold tracking-wide text-faint uppercase">
      {children}
    </div>
  );
}

// One grouped block: eyebrow + a plane-1 Card holding its control(s).
function Section({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Eyebrow>{label}</Eyebrow>
      <Card className="p-3.5">{children}</Card>
    </div>
  );
}

export function DispatchView() {
  const [repos, setRepos] = useState<Repo[]>([]);
  // Everything except title + prompt is a sticky preference: the form re-opens
  // with the last-used choice rather than resetting each time (loadRepos still
  // validates a stale repo id).
  const [repoId, setRepoId] = usePersistedString<string>("pref:dispatch-repo", "");
  const [agent, setAgent] = usePersistedString<AgentKind>("pref:dispatch-agent", "claude");
  // Model/effort/permission are remembered PER AGENT: each agent keeps its own
  // last choice, so switching claude↔codex restores that agent's trio instead of
  // resetting — and since each value comes from that agent's own option set, one
  // never leaks across agents.
  const [permission, setPermission] = usePersistedMapEntry<Permission>("pref:dispatch-permission", agent, DEFAULT_PERMISSION[agent]);
  const [model, setModel] = usePersistedMapEntry<string>("pref:dispatch-model", agent, DEFAULT_OPTION);
  const [effort, setEffort] = usePersistedMapEntry<string>("pref:dispatch-effort", agent, DEFAULT_OPTION);
  // Worktree isolation is remembered PER REPO (run a git task in an isolated
  // worktree+branch vs. in the repo itself). Default off (run in place).
  const [isolate, setIsolate] = usePersistedMapEntry<boolean>("pref:dispatch-isolate", repoId, false);
  // Persisted so a deploy refresh (or accidental reload) never drops typing.
  const [title, setTitle] = useDraft("draft:dispatch-title");
  const [prompt, setPrompt] = useDraft("draft:dispatch-prompt");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const att = useImageAttachments(setError);
  // Worktree isolation only applies to git repos — a plain folder always runs in
  // place, so the toggle is hidden and never sent for it.
  const isGit = repos.find((r) => r.id === repoId)?.vcs === "git";

  async function loadRepos(selectId?: string) {
    try {
      const list = await api.listRepos();
      setRepos(list);
      setRepoId((cur) => {
        if (selectId) return selectId; // just-added repo
        if (cur && list.some((r) => r.id === cur)) return cur; // keep valid selection
        return list[0]?.id ?? "";
      });
    } catch (e) {
      setError(errMsg(e));
    }
  }

  useEffect(() => {
    void loadRepos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function dispatch(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!repoId) return setError("Register and select a repo first.");
    if (!prompt.trim() && att.images.length === 0) return setError("Enter a prompt.");
    setBusy(true);
    try {
      const task = await api.createTask({
        repoId,
        agent,
        prompt: prompt.trim() || "See the attached image(s).",
        permission,
        ...(model !== DEFAULT_OPTION ? { model } : {}),
        ...(effort !== DEFAULT_OPTION ? { effort } : {}),
        ...(isGit && isolate ? { isolate: true } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(att.images.length ? { images: att.images } : {}),
      });
      clearDraft("draft:dispatch-title", "draft:dispatch-prompt");
      toast({ title: "Dispatched", variant: "success" });
      // Replace the dispatch form in history so Back returns to the inbox, not /new.
      navigate(`/task/${encodeURIComponent(task.taskId)}`, { replace: true });
    } catch (e) {
      // Transient REST failure → toast (the form stays put so the user can retry
      // without re-typing). Inline Alert is reserved for the pre-flight
      // validation guards above.
      toast({ title: "Couldn't dispatch", description: errMsg(e), variant: "destructive" });
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <AppBar title="Dispatch" back />
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={dispatch}>
        {/* Scrollable fields, migrated to the Radix ScrollArea primitive (matching
            EventLog/PullToRefresh — the primitive directly, not the ui wrapper, to
            dodge the horizontal-overflow regression: overflow-hidden on Root + a
            styled ScrollBar). index.css forces the Radix content wrapper to
            display:block, so we give it a definite height ([&>div]:h-full) — that
            lets the inner column's min-h-full resolve and the prompt keep growing to
            fill a tall screen (#41) while still scrolling when content overflows.
            pb-6 keeps the last field off the sticky footer instead of butting against
            it (the original gripe). */}
        <ScrollAreaPrimitive.Root className="relative min-h-0 flex-1 overflow-hidden">
          <ScrollAreaPrimitive.Viewport className="h-full w-full [&>div]:h-full">
            <div className="flex min-h-full flex-col gap-5 px-4 pt-4 pb-6">
              {error && <Alert variant="destructive">{error}</Alert>}

              <Section label="Repo">
                <div className="flex gap-2.5">
                  {/* The "" guard matters: when value and items land in the same render,
                      Radix's hidden form-bridge <select> fires a change with a stale ""
                      before the new options register — letting it through wipes the
                      auto-selection. ("" never means anything here anyway.) */}
                  <Select value={repoId} onValueChange={(v) => v && setRepoId(v)} disabled={repos.length === 0}>
                    <SelectTrigger className="flex-1">
                      <SelectValue
                        placeholder={repos.length === 0 ? "no repos registered" : "select a repo"}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {repos.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.name}{" "}
                          <span className="text-muted-foreground">
                            ({r.vcs === "none" ? "folder" : r.defaultBaseRef})
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="secondary"
                    className="shrink-0"
                    onClick={() => setPickerOpen(true)}
                  >
                    <Plus /> Add
                  </Button>
                </div>
              </Section>

              <Section label="Agent">
                {/* Model + effort + permission are remembered per agent (the
                    usePersistedMapEntry trio above), so switching only changes the
                    agent — each agent's own last choices come back with it. */}
                <ToggleGroup
                  type="single"
                  value={agent}
                  onValueChange={(v) => v && setAgent(v as AgentKind)}
                >
                  {AGENTS.map((a) => (
                    <ToggleGroupItem key={a} value={a}>
                      {a}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Section>

              <Section label="Permission">
                {/* Per-agent vocabulary — see PERMISSIONS. A Select (not a toggle
                    row) so the longer per-agent values + descriptions never overflow
                    the 360px viewport; the trigger shows only the short label. */}
                <Select value={permission} onValueChange={(v) => v && setPermission(v)}>
                  <SelectTrigger aria-label="Permission">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-w-[min(20rem,calc(100vw-1.25rem))]">
                    {PERMISSIONS[agent].map((p) => (
                      <SelectItem key={p.value} value={p.value} textValue={p.label} description={p.description}>
                        <span className={p.danger ? "text-destructive" : undefined}>{p.label}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Section>

              <Section label="Model & effort">
                <div className="flex gap-2.5">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Label>Model</Label>
                    <Select value={model} onValueChange={(v) => v && setModel(v)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MODELS[agent].map((m) => (
                          <SelectItem key={m.value} value={m.value}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Label>Effort</Label>
                    <Select value={effort} onValueChange={(v) => v && setEffort(v)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EFFORTS[agent].map((eo) => (
                          <SelectItem key={eo.value} value={eo.value}>
                            {eo.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </Section>

              {isGit && (
                <Section label="Isolation">
                  <label className="flex min-h-[44px] items-center justify-between gap-3">
                    <span className="flex min-w-0 flex-col">
                      <span className="text-[15px] text-foreground">Isolated worktree</span>
                      <span className="text-[12.5px] text-muted-foreground">
                        Run in a per-task branch + worktree. Off = run directly in the repo.
                      </span>
                    </span>
                    <Switch
                      checked={isolate}
                      onCheckedChange={setIsolate}
                      aria-label="Isolated worktree"
                    />
                  </label>
                </Section>
              )}

              <Section label="Title">
                <div className="space-y-1.5">
                  <Label htmlFor="dispatch-title">Title (optional)</Label>
                  <Input
                    id="dispatch-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="short label"
                  />
                </div>
              </Section>

              {/* Prompt grows to fill the scroll area so there's no dead space on a
                  tall screen (#41), while keeping the redesign's eyebrow + Card
                  grouping. min-h-0 lets it shrink (and the body scroll) when the
                  keyboard squeezes the viewport. */}
              <div className="flex min-h-0 flex-1 flex-col space-y-2">
                <Eyebrow>Prompt</Eyebrow>
                {/* The Textarea IS the box (its own border) and grows to fill via
                    flex-1 — no wrapping Card. A Card wrapper collapsed to ~30px when
                    the keyboard squeezed the scroll container while the textarea's
                    min-height overflowed it, leaving a thin pill + dead gap (#46
                    follow-up). min-h-0 lets it shrink with the viewport; the
                    textarea's own min-h keeps it usable, and it scrolls when squeezed. */}
                <Textarea
                  id="dispatch-prompt"
                  aria-label="Prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onPaste={att.onPaste}
                  className="min-h-[7rem] flex-1 resize-none"
                  placeholder="What should the agent do? (paste images here)"
                />
                <AttachmentTray
                  images={att.images}
                  preparing={att.preparing}
                  disabled={busy}
                  onAdd={(f) => void att.addFiles(f)}
                  onRemove={att.remove}
                />
              </div>
            </div>
          </ScrollAreaPrimitive.Viewport>
          <ScrollBar />
        </ScrollAreaPrimitive.Root>

        {/* Sticky plane-2 submit footer — translucent blur, keyboard-safe, never squished */}
        <div className="shrink-0 border-t border-border bg-background/85 px-4 pt-3 pb-[calc(16px+var(--safe-bottom))] backdrop-blur-md">
          <Button type="submit" size="lg" className="w-full" disabled={busy || att.preparing}>
            {busy ? (
              <>
                <Loader2 className="animate-spin" /> Dispatching…
              </>
            ) : (
              <>
                Dispatch <Send className="size-4" />
              </>
            )}
          </Button>
        </div>
      </form>
      <RepoPicker
        open={pickerOpen}
        repos={repos}
        onClose={() => setPickerOpen(false)}
        onRegistered={(repo) => {
          setPickerOpen(false);
          void loadRepos(repo.id);
        }}
        onChanged={() => void loadRepos()}
      />
    </AppShell>
  );
}
