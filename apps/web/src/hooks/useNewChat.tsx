import { gameDelivery } from "../games/play-events";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import type { AgentKind, InputAttachment, PendingMessage, Permission, TaskState } from "@palmagent/shared";
import { Folder, GitBranch, Plus } from "lucide-react";
import { ApiError, DEFAULT_OPTION, DEFAULT_PERMISSION } from "../api";
import { useNewChatSubmission, type NewChatSubmission as Submission } from "../new-chat-state";
import { peekActionState, useActionState } from "../action-state";
import { cacheSession } from "../query-lifecycle";
import { beginTaskAction, useTaskActivity } from "../task-activity";
import { stopTaskTurn } from "../task-stop";
import { useRepoMutations } from "../repo-mutations";
import { modelSelection, useAgentCatalog } from "../model-catalog";
import { navigate } from "../router";
import { newTaskPath, spaceQualifier } from "../space-context";
import { useUpdateState } from "../update-state";
import { readDraft, useDraft, usePersistedMapEntry, usePersistedString } from "./useDraft";
import { useRepos } from "./useRepos";
import { useDispatchOperations } from "./remote-operations";
import { useImageAttachments } from "../components/Attachments";
import { Composer } from "../components/Composer";
import { useSkillDraft } from "../components/SkillPicker";
import { selectablePermission } from "../components/PermissionPicker";
import { RepoPicker } from "../components/RepoPicker";
import type { DeliveryControls } from "../components/MessageDelivery";
import { Button } from "../components/ui/button";
import { Drawer, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle, DrawerDescription } from "../components/ui/drawer";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Field, FieldContent, FieldDescription, FieldLabel } from "../components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";

/** Creation is a phase of the conversation, with a retryable first message. */
export function useNewChat(enabled: boolean, onCreated?: (task: TaskState) => void, initialRepoId?: string) {
  const operations = useDispatchOperations();
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = enabled; return () => { mounted.current = false; }; }, [enabled]);
  const { repos: registered, loaded, error: reposError, refresh } = useRepos();
  const mutations = useRepoMutations();
  const repos = useMemo(() => [...registered.values()].filter(repo => !mutations.removed.has(repo.id)), [registered, mutations.removed]);
  const initialized = useRef(false);
  const routeRepo = useRef(initialRepoId);
  const [lastRepoId, saveRepoId] = usePersistedString<string>("pref:dispatch-repo", "");
  const [repoId, setRepoId] = useState(initialRepoId ?? lastRepoId);
  const [submission, setSubmission] = useNewChatSubmission();
  const draftRepoId = submission?.request.repoId ?? repoId;
  const promptKey = `draft:dispatch-prompt:${draftRepoId || "unassigned"}`;
  const imagesKey = `images:#/new:${draftRepoId || "unassigned"}`;
  const [agent, setAgent] = usePersistedString<AgentKind>("pref:dispatch-agent", "claude");
  const [savedPermission, setPermission] = usePersistedMapEntry<Permission>("pref:dispatch-permission", agent, DEFAULT_PERMISSION[agent]);
  const permission = selectablePermission(agent, savedPermission);
  const [savedModel, saveModel] = usePersistedMapEntry<string>("pref:dispatch-model", agent, DEFAULT_OPTION);
  const [savedEffort, setEffort] = usePersistedMapEntry<string>("pref:dispatch-effort", agent, DEFAULT_OPTION);
  const catalog = useAgentCatalog(agent);
  const { model, effort, setModel } = modelSelection(catalog, savedModel, savedEffort, saveModel, setEffort);
  const [isolate, setIsolate] = usePersistedMapEntry<boolean>("pref:dispatch-isolate", repoId, false);
  const [legacyPrompt, setLegacyPrompt] = useDraft("draft:dispatch-prompt");
  const [legacyImages, setLegacyImages] = useActionState<InputAttachment[]>("images:#/new", []);
  const [prompt, setPrompt] = useDraft(promptKey);
  const [skills, setSkills] = useSkillDraft(`draft:dispatch-skills:${draftRepoId}:${agent}`);
  const [pickerOpen, setPickerOpen] = useUpdateState("dispatch:picker", false);
  const [error, setError] = useState("");
  const att = useImageAttachments(setError, imagesKey);
  const [conflictingSpace, setConflictingSpace] = useState<string>();
  const [spaceNotice, setSpaceNotice] = useActionState(`dispatch:space-notice:${draftRepoId}`, "");
  const changingRoute = useRef(false);
  const transfer = useRef<{ repoId: string; prompt: string; images: InputAttachment[]; notice: string } | undefined>(undefined);
  useLayoutEffect(() => {
    const pending = transfer.current;
    if (pending?.repoId === repoId) {
      transfer.current = undefined;
      setPrompt(pending.prompt); att.setImages(pending.images); setSkills([]); setSpaceNotice(pending.notice);
    }
    if (changingRoute.current) {
      changingRoute.current = false;
      navigate(newTaskPath(repoId), { replace: true });
    }
  }, [repoId]);
  useEffect(() => {
    // Preserve a pre-Spaces update checkpoint as one draft, including images.
    if (enabled && loaded && (!repoId || repos.some(repo => repo.id === repoId))
      && (legacyPrompt || legacyImages.length) && !prompt && !att.images.length) {
      setPrompt(legacyPrompt); att.setImages(legacyImages);
      setLegacyPrompt(""); setLegacyImages([]);
    }
    if (enabled && loaded && repos.some(repo => repo.id === repoId)) saveRepoId(repoId);
  }, [enabled, loaded, repoId]);
  function selectSpace(value: string, replace = false, saved = false) {
    if (value === repoId) return;
    const hasDraft = !!prompt.trim() || !!att.images.length || !!skills.length;
    const targetPrompt = peekActionState<string>(`draft:dispatch-prompt:${value}`) ?? readDraft(`draft:dispatch-prompt:${value}`);
    const targetImages = peekActionState<InputAttachment[]>(`images:#/new:${value}`);
    const targetSkills = peekActionState<string>(`draft:dispatch-skills:${value}:${agent}`) ?? readDraft(`draft:dispatch-skills:${value}:${agent}`);
    if (hasDraft && !replace && !saved && (targetPrompt || targetImages?.length || targetSkills)) { setConflictingSpace(value); return; }
    if (hasDraft && !saved) {
      transfer.current = { repoId: value, prompt, images: att.images,
        notice: skills.length ? "Your Skills are saved with the previous Space. Choose Skills available in this Space before sending." : "" };
    }
    setConflictingSpace(undefined); changingRoute.current = true; setRepoId(value);
  }
  const [accepted, setAccepted] = useState<Submission | null>(null);
  const activity = useTaskActivity("dispatch");
  const busy = !!activity.kind;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!busy) return;
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [busy]);
  const isGit = repos.find(repo => repo.id === repoId)?.vcs === "git";
  // Freeze the submitted payload until creation is resolved. Draft storage is
  // cleared only after success, so navigating away never discards the input.
  const locked = busy || !!submission;
  useEffect(() => {
    if (!enabled || !loaded || locked) return;
    if (!initialized.current || routeRepo.current !== initialRepoId) {
      initialized.current = true;
      routeRepo.current = initialRepoId;
      setRepoId(current => initialRepoId
        ? repos.some(repo => repo.id === initialRepoId) ? initialRepoId : ""
        : repos.some(repo => repo.id === current) ? current : repos.length === 1 ? repos[0].id : "");
    } else setRepoId(current => repos.some(repo => repo.id === current) ? current : "");
  }, [enabled, loaded, repos, initialRepoId, locked]);

  async function submit(saved?: Submission, checkOnly = false) {
    if (busy) return;
    setError("");
    if (!saved && !repos.some(repo => repo.id === repoId)) { setError("Choose a Space first."); return; }
    const text = prompt.trim() || (skills.length ? "Use the selected skill." : att.images.length ? att.images.some(image => image.video) ? "See the attached media." : "See the attached image(s)." : "");
    if (!saved && !text) return;
    const next: Submission = saved ?? { draft: prompt, status: "sending", request: {
      clientRequestId: crypto.randomUUID(), repoId, agent, prompt: text, permission,
      ...(skills.length ? { skills } : {}), ...(att.images.length ? { images: att.images } : {}),
      ...(model !== DEFAULT_OPTION ? { model } : {}), ...(effort !== DEFAULT_OPTION ? { effort } : {}),
      ...(isGit && isolate ? { isolate: true } : {}),
    } };
    const generation = cacheSession();
    let created: TaskState | undefined;
    const finish = beginTaskAction("dispatch", "dispatch", undefined, async () => {
      if (created) await stopTaskTurn(created.taskId);
      else setSubmission(current => current ? { ...current, stop: true } : current);
    }, "");
    if (!finish) return;
    setSubmission({ ...next, status: "sending", error: undefined });
    if (!checkOnly) gameDelivery({ id: next.request.clientRequestId, state: "sending" });
    try {
      // Always check the durable ID before retrying an uncertain request. A 404
      // can race the original POST; replaying the same ID remains idempotent.
      if (saved) {
        try { created = await operations.getTask(`t_${next.request.clientRequestId}`); }
        catch (cause) { if (!(cause instanceof ApiError && cause.status === 404)) throw cause; }
      }
      if (!created && checkOnly) {
        gameDelivery({ id: next.request.clientRequestId, state: "failed" });
        setSubmission(current => ({ ...next, stop: current?.stop ?? next.stop, status: "unknown", error: "Creation is not confirmed yet. Retry safely to reconnect or finish creating this conversation." }));
        return;
      }
      created ??= await operations.createTask(next.request);
      if (generation !== cacheSession()) return;
      if (next.stop) await stopTaskTurn(created.taskId);
      gameDelivery({ id: next.request.clientRequestId, taskId: created.taskId, state: "sent" });
      setPrompt(current => current === next.draft ? "" : current);
      att.setImages(current => JSON.stringify(current) === JSON.stringify(next.request.images ?? []) ? [] : current);
      setSkills(current => JSON.stringify(current) === JSON.stringify(next.request.skills ?? []) ? [] : current);
      setSubmission(null);
      if (mounted.current) { setAccepted({ ...next, status: "sending", error: undefined }); onCreated?.(created); }
    } catch (cause) {
      if (generation !== cacheSession()) return;
      gameDelivery({ id: next.request.clientRequestId, state: "failed" });
      const rejected = (!saved || saved.status === "rejected") && cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      setSubmission(current => ({ ...next, stop: current?.stop ?? next.stop, status: rejected ? "rejected" : "unknown",
        error: cause instanceof Error ? cause.message : String(cause) }));
    } finally { finish(); }
  }

  const preview = submission ?? accepted;
  const message: PendingMessage | undefined = preview ? { id: preview.request.clientRequestId, version: 0, mode: "send",
    text: preview.request.prompt, images: preview.request.images, skills: preview.request.skills,
    status: preview.status, error: preview.error } : undefined;
  const delivery: DeliveryControls = { messages: message ? [message] : [], paused: false, disabled: busy, resumeDisabled: true,
    onDelete: () => {
      if (submission?.status !== "rejected") return;
      setPrompt(submission.draft); att.setImages(submission.request.images ?? []); setSkills(submission.request.skills ?? []);
      setSubmission(null);
    }, onResume: () => {},
    pendingHint: busy && slow ? "Preparing conversation…" : undefined,
    recovery: { retry: () => { if (submission) void submit(submission); }, check: () => { if (submission) void submit(submission, true); } } };
  const composer: ComponentProps<typeof Composer> = {
    id: "dispatch-prompt", label: "Prompt", value: locked ? "" : prompt, onChange: setPrompt,
    placeholder: "Work with Palmagent", action: "Send now", onSend: () => void submit(), busy,
    sendDisabled: !repos.some(repo => repo.id === repoId),
    disabled: !!submission && !busy, attachments: locked ? { ...att, images: [] } : att,
    skills: locked ? [] : skills, onSkillsChange: setSkills, skillContext: repoId ? { repoId, agent } : undefined,
    onStop: busy ? () => { setSubmission(current => current ? { ...current, stop: true } : current); void stopTaskTurn("dispatch"); } : undefined, stopping: !!activity.stopping,
    description: "Your choices are remembered for this agent.",
    settings: { agent, onAgentChange: setAgent, model,
      onModelChange: setModel,
      effort, onEffortChange: setEffort, permission, onPermissionChange: setPermission,
      children: isGit && <Field orientation="horizontal">
        <FieldContent><FieldLabel htmlFor="dispatch-isolation">Isolated worktree</FieldLabel>
          <FieldDescription>Run in a separate branch and worktree.</FieldDescription></FieldContent>
        <Switch id="dispatch-isolation" disabled={locked} checked={isolate} onCheckedChange={setIsolate} aria-label="Isolated worktree" />
      </Field> },
  };
  const workspace = <div className="flex min-h-11 min-w-0 items-center gap-2">
    <Select value={submission?.request.repoId ?? repoId} disabled={locked || !loaded || att.preparing} onValueChange={value => {
      if (value === "__add__") { setPickerOpen(true); return; }
      selectSpace(value);
    }}>
      <SelectTrigger aria-label="Space" className="min-h-11 min-w-0 flex-1 rounded-full">
        <Folder className="size-4 shrink-0" /><SelectValue placeholder="Choose a Space" />
      </SelectTrigger>
      <SelectContent><SelectGroup>
        {repos.map(repo => <SelectItem key={repo.id} value={repo.id}>{repo.name}{spaceQualifier(repo, registered) && <span className="text-muted-foreground"> · {spaceQualifier(repo, registered)}</span>}</SelectItem>)}
        <SelectItem value="__add__"><Plus className="size-4" />Add Space</SelectItem>
      </SelectGroup></SelectContent>
    </Select>
    {isGit && isolate && <Badge variant="secondary"><GitBranch className="size-3" />Isolated</Badge>}
  </div>;
  const notices = <>{(error || reposError) && <Alert variant="destructive">{error || reposError}</Alert>}{spaceNotice && !skills.length && <Alert>{spaceNotice}</Alert>}</>;
  const picker = <><RepoPicker open={enabled && pickerOpen} repos={[...registered.values()]} onClose={() => setPickerOpen(false)}
    onRegistered={repo => { setPickerOpen(false); selectSpace(repo.id); }}
    onChanged={() => { void refresh().catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }} />
    <Drawer open={!!conflictingSpace} onOpenChange={open => { if (!open) setConflictingSpace(undefined); }}>
      <DrawerContent><DrawerHeader><DrawerTitle>A draft is already saved in this Space</DrawerTitle><DrawerDescription>Your current draft will stay saved in its original Space.</DrawerDescription></DrawerHeader>
        <DrawerFooter className="pt-3">
          <Button variant="ghost" onClick={() => setConflictingSpace(undefined)}>Cancel</Button>
          <Button variant="outline" onClick={() => selectSpace(conflictingSpace!, true)}>Replace saved draft with current draft</Button>
          <Button onClick={() => selectSpace(conflictingSpace!, false, true)}>Open saved draft</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer></>;
  return { composer, workspace, notices, picker, delivery, preview };
}
