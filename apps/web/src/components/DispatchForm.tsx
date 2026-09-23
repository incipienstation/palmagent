import { stopTaskTurn } from "../task-stop";
import { beginTaskAction, useTaskActivity } from "../task-activity";
import { useRepoMutations } from "../repo-mutations";
import { useToastObstacle } from "../hooks/useToastObstacle";
import { useUpdateState } from "../update-state";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { AgentKind, Permission, Repo } from "@palmagent/shared";
import { Plus } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toaster";
import { api, ApiError, DEFAULT_OPTION, DEFAULT_PERMISSION } from "../api";
import { selectableEffort, selectableModel, useAgentCatalog } from "../model-catalog";
import { useDraft, usePersistedMapEntry, usePersistedString } from "../hooks/useDraft";
import { navigate } from "../router";
import { ALL_SPACES, readSelectedSpace, repoForSelectedSpace, spaceName, writeSelectedSpace } from "../space-context";
import { AppBar, AppShell } from "./AppShell";
import { useImageAttachments } from "./Attachments";
import { useSkillDraft } from "./SkillPicker";
import { Composer } from "./Composer";
import { RepoPicker } from "./RepoPicker";

function errMsg(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : String(e);
}

export function DispatchView() {
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const toastObstacle = useToastObstacle();
  const [registeredRepos, setRepos] = useState<Repo[]>([]);
  const repoMutations = useRepoMutations();
  const repos = registeredRepos.filter(repo => !repoMutations.removed.has(repo.id));
  const [inheritedSpace, setInheritedSpace] = useState(readSelectedSpace);
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
  const [savedModel, saveModel] = usePersistedMapEntry<string>("pref:dispatch-model", agent, DEFAULT_OPTION);
  const [savedEffort, setEffort] = usePersistedMapEntry<string>("pref:dispatch-effort", agent, DEFAULT_OPTION);
  const catalog = useAgentCatalog(agent);
  const model = selectableModel(catalog, savedModel);
  const effort = selectableEffort(catalog, model, savedEffort);
  function setModel(value: string) {
    saveModel(value);
    setEffort(selectableEffort(catalog, value, effort));
  }
  // Worktree isolation is remembered PER REPO (run a git task in an isolated
  // worktree+branch vs. in the repo itself). Default off (run in place).
  const [isolate, setIsolate] = usePersistedMapEntry<boolean>("pref:dispatch-isolate", repoId, false);
  // Persisted so a deploy refresh (or accidental reload) never drops typing.
  const [title, setTitle] = useDraft("draft:dispatch-title");
  const [prompt, setPrompt] = useDraft("draft:dispatch-prompt");
  const [skills, setSkills] = useSkillDraft(`draft:dispatch-skills:${repoId}:${agent}`);
  const [pickerOpen, setPickerOpen] = useUpdateState(`dispatch:picker`, false);
  const activity = useTaskActivity("dispatch");
  const busy = Boolean(activity.label);
  const [error, setError] = useState("");
  const att = useImageAttachments(setError);
  // Worktree isolation only applies to git repos — a plain folder always runs in
  // place, so the toggle is hidden and never sent for it.
  const isGit = repos.find((r) => r.id === repoId)?.vcs === "git";

  async function loadRepos(selectId?: string) {
    try {
      const list = await api.listRepos();
      const byId = new Map(list.map((repo) => [repo.id, repo]));
      const inheritedRepoId = selectId ? undefined : repoForSelectedSpace(inheritedSpace, byId);
      setRepos(list);
      setRepoId((cur) => {
        if (selectId) return selectId; // just-added repo
        if (inheritedRepoId && byId.has(inheritedRepoId)) return inheritedRepoId;
        if (cur && list.some((r) => r.id === cur)) return cur; // keep valid selection
        return list[0]?.id ?? "";
      });
    } catch (e) {
      setError(errMsg(e));
    }
  }

  const repoMap = new Map(repos.map((repo) => [repo.id, repo]));
  const inheritedRepoId = repoForSelectedSpace(inheritedSpace, repoMap);
  const inheritedName = inheritedSpace === ALL_SPACES ? "" : spaceName(inheritedSpace, repoMap);
  const contextDescription = inheritedName
    ? inheritedRepoId === repoId ? `Inherited from Space: ${inheritedName}` : `Space context: ${inheritedName}`
    : "";

  useEffect(() => {
    void loadRepos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function dispatch(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!repos.some(repo => repo.id === repoId)) return setError("Register and select a repo first.");
    if (!prompt.trim() && att.images.length === 0 && !skills.length) return setError("Enter a prompt.");
    let createdTaskId: string | undefined;
    const finish = beginTaskAction("dispatch", title.trim() || prompt.trim() || "New task", undefined, async () => {
      if (createdTaskId) await stopTaskTurn(createdTaskId);
    });
    if (!finish) return;
    try {
      const task = await api.createTask({
        repoId,
        agent,
        prompt: prompt.trim() || (skills.length ? "Use the selected skill." : "See the attached image(s)."),
        ...(skills.length ? { skills } : {}),
        permission,
        ...(model !== DEFAULT_OPTION ? { model } : {}),
        ...(effort !== DEFAULT_OPTION ? { effort } : {}),
        ...(isGit && isolate ? { isolate: true } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(att.images.length ? { images: att.images } : {}),
      });
      createdTaskId = task.taskId;
      // A late acknowledgement must not erase work entered after navigating
      // away and reopening the form. Clear only the draft that was submitted.
      setTitle(current => current === title ? "" : current);
      setPrompt(current => current === prompt ? "" : current);
      att.setImages(current => current === att.images ? [] : current);
      setSkills(current => JSON.stringify(current) === JSON.stringify(skills) ? [] : current);
      toast({ title: "Dispatched", variant: "success" });
      // Replace only this still-mounted form; Back may have already taken the
      // user elsewhere (including a new instance of the dispatch form).
      if (mounted.current) navigate(`/task/${encodeURIComponent(task.taskId)}`, { replace: true });
    } catch (e) {
      // Transient REST failure → toast (the form stays put so the user can retry
      // without re-typing). Inline Alert is reserved for the pre-flight
      // validation guards above.
      toast({ title: "Couldn't dispatch", description: e instanceof ApiError && e.status < 500 ? errMsg(e) : `${errMsg(e)} Check Tasks before retrying; creation could not be confirmed.`, variant: "destructive" });
    } finally { finish(); }
  }

  return (
    <AppShell>
      <AppBar title="New task" back />
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={dispatch}>
        <div className="flex min-h-0 flex-1 flex-col justify-end overflow-y-auto px-4 pb-5">
          {busy && <div role="status" className="rounded-xl border border-border p-4"><p className="line-clamp-2 font-medium">{activity.label}</p><p className="text-sm text-muted-foreground">Creating task…</p></div>}
          <div className="flex flex-col gap-3 py-4">
            <p className="text-lg font-medium text-strong">What should we work on?</p>
            <Field>
              <FieldLabel htmlFor="dispatch-repo">Working directory</FieldLabel>
              <div className="flex min-w-0 gap-2">
                <Select value={repoId} onValueChange={(v) => {
                  if (!v) return;
                  setRepoId(v);
                  const repo = repos.find((candidate) => candidate.id === v);
                  if (repo) {
                    setInheritedSpace(repo.path);
                    writeSelectedSpace(repo.path, repo.id);
                  }
                }} disabled={repos.length === 0 || busy}>
                  <SelectTrigger id="dispatch-repo" className="min-w-0 flex-1 rounded-full">
                    <SelectValue placeholder={repos.length === 0 ? "No repos registered" : "Select a repo"} />
                  </SelectTrigger>
                  <SelectContent><SelectGroup>{repos.map((r) => <SelectItem key={r.id} value={r.id}>
                    {r.name} <span className="text-muted-foreground">({r.vcs === "none" ? "folder" : r.defaultBaseRef})</span>
                  </SelectItem>)}</SelectGroup></SelectContent>
                </Select>
                <Button type="button" variant="secondary" className="shrink-0 rounded-full" disabled={busy} onClick={() => setPickerOpen(true)}><Plus data-icon="inline-start" /> Add</Button>
              </div>
              {contextDescription && <FieldDescription>{contextDescription}</FieldDescription>}
            </Field>
          </div>
        </div>
        <div ref={toastObstacle} className="flex shrink-0 flex-col gap-2 px-3 pb-[calc(12px+var(--safe-bottom))]">
          {error && <Alert variant="destructive">{error}</Alert>}
          <Composer skillContext={repoId ? { repoId, agent } : undefined} skills={skills} onSkillsChange={setSkills} id="dispatch-prompt" label="Prompt" value={prompt} onChange={setPrompt}
            placeholder="Work with Palmagent" action="Dispatch" busy={busy}
            onStop={busy ? () => void stopTaskTurn("dispatch") : undefined} stopping={!!activity.stopping}
            attachments={att} description="Your choices are remembered for this agent."
            settings={{ agent, onAgentChange: setAgent, model, onModelChange: setModel,
              effort, onEffortChange: setEffort, permission, onPermissionChange: setPermission,
              children: <>
                {isGit && <Field orientation="horizontal">
                  <FieldContent><FieldLabel htmlFor="dispatch-isolation">Isolated worktree</FieldLabel>
                    <FieldDescription>Run in a separate branch and worktree.</FieldDescription></FieldContent>
                  <Switch id="dispatch-isolation" disabled={busy} checked={isolate} onCheckedChange={setIsolate} aria-label="Isolated worktree" />
                </Field>}
                <Field><FieldLabel htmlFor="dispatch-title">Title (optional)</FieldLabel>
                  <Input disabled={busy} id="dispatch-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="short label" />
                </Field>
              </>,
            }} />
        </div>
      </form>
      <RepoPicker
        open={pickerOpen}
        repos={registeredRepos}
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
