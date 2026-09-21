import { TerminalsView } from "./Terminals";
import { useActionState } from "../action-state";
import { cacheSession } from "../read-cache";
import { acceptMessageQueue, clearQueuePreview, finishWhenStopped, beginTaskAction, useTaskActivity, type QueuePreview } from "../task-activity";
import { mutateTask, useTaskMutations } from "../task-mutations";
import { useToastObstacle } from "../hooks/useToastObstacle";
import { SendControl } from "./SendControl";
import { MessageQueue as QueuePanel } from "./MessageQueue";
import type { MessageQueue, PendingMessage, SubmitMessage } from "@palmagent/shared";
import { readUpdateSnapshot, useUpdateState } from "../update-state";
import { useEffect, useRef, useState } from "react";
import type { TaskState } from "@palmagent/shared";
import { Archive, Check, ChevronDown, Square, Trash2, X, Terminal } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toaster";
import { api, ApiError, DEFAULT_OPTION, DEFAULT_PERMISSION, selectableModel, selectableEffort, PERMISSIONS } from "../api";
import { useDraft, usePersistedString } from "../hooks/useDraft";
import { useTaskStream } from "../hooks/useTaskStream";
import { navigate } from "../router";
import { AppBar, AppShell, ConnPill } from "./AppShell";
import { useImageAttachments } from "./Attachments";
import { useSkillDraft } from "./SkillPicker";
import { Composer } from "./Composer";
import { AgentTag, StatusBadge } from "./chips";
import { PrList } from "./PrChip";
import { EventLog, UserBubble } from "./EventLog";
import { QuestionCard } from "./QuestionCard";
import { SessionHandoff } from "./SessionHandoff";
import { Alert } from "./ui/alert";
import { SessionActionsMenu } from "./SessionActionsMenu";
import { taskTitle } from "@/lib/task-title";
import { TaskStatusline } from "./TaskStatusline";
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "./ui/sheet";

function errMsg(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : String(e);
}

// Short label for a task's permission value (the catalog label, or the raw value
// for a legacy/unknown one). Used in the metadata strip + the composer picker.
function permLabel(agent: TaskState["agent"], value: string): string {
  return PERMISSIONS[agent].find((p) => p.value === value)?.label ?? value;
}

export function TaskDetailView({ taskId, task: inboxTask }: { taskId: string; task?: TaskState }) {
  const [terminalOpen, setTerminalOpen] = useUpdateState(`task:${taskId}:terminal-open`, false);
  const toastObstacle = useToastObstacle();
  const { log, conn, loadingHistory, hasEarlier, loadingEarlier, historyError, loadEarlier, task: streamTask } = useTaskStream(taskId);
  // Trust the scoped stream's snapshot (it's the connection that's actually live
  // while you're on this page) over the inbox-provided task, which can go stale
  // when the long-lived inbox stream freezes in the background. Fall back to the
  // inbox task for the first paint before the scoped snapshot arrives.
  const task = streamTask ?? inboxTask;
  // Per-task draft, persisted so a deploy refresh never drops an unsent steer/follow-up.
  const [compose, setCompose] = useDraft(`draft:compose:${taskId}`);
  const [skills, setSkills] = useSkillDraft(`draft:skills:${taskId}`);
  const [editSkills, setEditSkills] = useSkillDraft(`draft:queue-skills:${taskId}`);
  // The compose selectors mirror the task's live model/effort (DEFAULT_OPTION =
  // the agent's own default). They re-sync whenever the task's setting changes —
  // e.g. after a steer persists a new one — instead of resetting to "default"
  // each turn. Changes are captured by queued messages or the next idle Send;
  // an active Send keeps the current run settings.
  const keepRestoredSelectors = useRef(readUpdateSnapshot(`task:${taskId}:model`) !== undefined);
  const selectorVersion = useRef<string>(undefined);
  const [savedModel, saveModel] = useUpdateState(`task:${taskId}:model`, task?.model ?? DEFAULT_OPTION);
  const [savedEffort, setEffort] = useUpdateState(`task:${taskId}:effort`, task?.effort ?? DEFAULT_OPTION);
  const model = selectableModel(task?.agent ?? "codex", savedModel);
  const effort = selectableEffort(task?.agent ?? "codex", model, savedEffort);
  function setModel(value: string) {
    saveModel(value);
    setEffort(selectableEffort(task?.agent ?? "codex", value, effort));
  }
  // Permission has no DEFAULT_OPTION (always a concrete value); clamp the task's
  // stored value to a valid option for its agent (a legacy value shows the agent
  // default in the picker). A change applies to the next turn, like model/effort.
  const [permission, setPermission] = useUpdateState<string>(`task:${taskId}:permission`, "");
  useEffect(() => {
    if (!task) return;
    const version = JSON.stringify([taskId, task.model, task.effort, task.permission, task.agent]);
    if (version === selectorVersion.current) return;
    selectorVersion.current = version;
    if (keepRestoredSelectors.current) { keepRestoredSelectors.current = false; return; }
    saveModel(task?.model ?? DEFAULT_OPTION);
    setEffort(task?.effort ?? DEFAULT_OPTION);
    const agent = task?.agent;
    const perm = task?.permission;
    if (agent) {
      const valid = !!perm && PERMISSIONS[agent].some((p) => p.value === perm);
      setPermission(valid ? (perm as string) : DEFAULT_PERMISSION[agent]);
    }
  }, [taskId, task?.model, task?.effort, task?.permission, task?.agent]);
  const activity = useTaskActivity(taskId);
  const busy = Boolean(activity.label);
  const normalAtt = useImageAttachments((msg) => toast({ title: msg, variant: "destructive" }));
  const editAtt = useImageAttachments((msg) => toast({ title: msg, variant: "destructive" }), `queue-edit-images:${taskId}`);
  const [deliveryMode, setDeliveryMode] = usePersistedString<"send" | "queue">(`delivery:${taskId}`, "send");
  const [edit, setEdit] = useActionState<{ id: string; version: number; token: string; expired?: boolean } | null>(`queue-edit:${taskId}`, null);
  const [editText, setEditText] = useDraft(`draft:queue-edit:${taskId}`);
  const [submitted, setSubmitted] = useActionState<{ fingerprint: string; id: string; request: Omit<SubmitMessage, "clientMessageId"> } | null>(`message-request:${taskId}`, null);
  const queueOverride = activity.queue;
  const setQueueOverride = (value: MessageQueue) => acceptMessageQueue(taskId, value);
  const remoteQueue = task?.messageQueue;
  const confirmedQueue = queueOverride && queueOverride.revision > (remoteQueue?.revision ?? -1) ? queueOverride : remoteQueue;
  const queue = activity.preview?.apply(confirmedQueue ?? { revision: 0, paused: false, runId: null, messages: [] }) ?? confirmedQueue;
  const pendingSend = queue?.messages.find(m => m.id === activity.preview?.id && m.version === 0 && m.mode === "send");
  const displayedQueue = pendingSend && queue ? { ...queue, messages: queue.messages.filter(m => m !== pendingSend) } : queue;
  const att = edit ? editAtt : normalAtt;
  useEffect(() => {
    if (!edit || edit.expired) return;
    const renew = () => { void api.messageAction(taskId, edit.id, { action: "renew", token: edit.token }).then(setQueueOverride).catch(() => setEdit(current => current ? { ...current, expired: true } : current)); };
    if (busy) return;
    renew(); const timer = setInterval(renew, 20_000);
    return () => clearInterval(timer);
  }, [taskId, edit?.id, edit?.token, edit?.expired, busy]);
  async function startEdit(message: PendingMessage) {
    const token = crypto.randomUUID();
    await act("Preparing edit…", async () => {
      const q = await api.messageAction(taskId, message.id, { action: "edit", version: message.version, token });
      setQueueOverride(q); setEdit({ id: message.id, version: message.version, token });
      setEditText(message.text); setEditSkills(message.skills ?? []); editAtt.setImages(message.images ?? []);
    });
  }
  async function endEdit(save: boolean) {
    if (!edit || busy || (save && (edit.expired || (!editText.trim() && !editSkills.length)))) return;
    const draft = edit;
    const text = editText || (editSkills.length ? "Use the selected skill." : "");
    const selectedSkills = editSkills;
    const images = editAtt.images;
    await act(save ? "Saving message…" : "Releasing edit…", async () => {
      // The lease remains represented by the pending action until release is
      // acknowledged. Keep the draft and restore the editor on failure.
      setEdit(null);
      try {
        if (save || !draft.expired) setQueueOverride(await api.messageAction(taskId, draft.id, save
          ? { action: "save", token: draft.token, version: draft.version, text, images, skills: selectedSkills }
          : { action: "release", token: draft.token }));
        editAtt.clear(); if (save) { setEditText(""); setEditSkills([]); }
      } catch (error) { setEdit({ ...draft, expired: true }); throw error; }
    }, undefined, { id: draft.id, label: save ? "Saving…" : "Releasing edit…", apply: q => ({ ...q, messages: q.messages.map(m => m.id === draft.id
      ? { ...m, ...(save ? { text, images, skills: selectedSkills } : {}), editingUntil: undefined } : m) }) });
  }

  const localOwner = !!task?.sessionControl && task.sessionControl.owner !== "palmagent";
  const status = task?.status;
  const running = status === "running";
  const awaiting = status === "awaiting_approval";
  const needsInput = status === "awaiting_input";
  const active = running || status === "queued" || awaiting || needsInput;
  // While a question is pending the task is awaiting_input, so the composer is
  // non-functional anyway ("No further input for this task"). Hide it (and the
  // helper line) so the QuestionCard + the session output above it get that room
  // back instead of the dead composer stacking under the panel and burying the log.
  const answering = needsInput && !!task?.pendingInput;
  // `interrupted` is a flag on idle tasks, not a status, so idle covers resume.
  const composeMode: "steer" | "followup" | null = localOwner || status === "archived" || status === "cancelled" ? null : running
    ? "steer"
    : status === "idle" || status === "failed" || deliveryMode === "queue"
      ? "followup"
      : null;

  async function send() {
    if (edit) { await endEdit(true); return; }
    const text = compose.trim() || (skills.length ? "Use the selected skill." : att.images.length ? "See the attached image(s)." : "");
    if (!text || !composeMode) return;
    const images = att.images.length ? att.images : undefined;
    // Send an override only when it differs from the task's current setting.
    // Picking "default" (DEFAULT_OPTION) sends "" — reset to the agent's default.
    const curModel = task?.model ?? DEFAULT_OPTION;
    const curEffort = task?.effort ?? DEFAULT_OPTION;
    const curPermission = task
      ? PERMISSIONS[task.agent].some((p) => p.value === task.permission)
        ? task.permission
        : DEFAULT_PERMISSION[task.agent]
      : permission;
    const override = {
      ...(model !== curModel ? { model: model === DEFAULT_OPTION ? "" : model } : {}),
      ...(effort !== curEffort ? { effort: effort === DEFAULT_OPTION ? "" : effort } : {}),
      ...(permission !== curPermission ? { permission } : {}),
    };
    const request = { mode: deliveryMode, text, images, ...(skills.length ? { skills } : {}), expectedRunId: confirmedQueue?.runId ?? null,
      ...(running && deliveryMode === "send" ? {} : { settings: override }) };
    const fingerprint = JSON.stringify({ mode: deliveryMode, text, images, skills, model, effort, permission });
    const id = submitted?.fingerprint === fingerprint ? submitted.id : crypto.randomUUID();
    const submission = submitted?.fingerprint === fingerprint ? submitted.request : request;
    const preview: PendingMessage = { id, version: 0, mode: deliveryMode, text, images, skills, status: deliveryMode === "queue" ? "queued" : "sending" };
    const originalDraft = compose;
    await act(deliveryMode === "queue" ? "Adding to queue…" : "Sending message…", async () => {
      setSubmitted({ fingerprint, id, request: submission });
      setCompose(""); setSkills([]); att.clear();
      try {
        setQueueOverride(await api.submitMessage(taskId, { ...submission, clientMessageId: id }));
        setSubmitted(null); setDeliveryMode("send");
      } catch (error) {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) setSubmitted(null);
        setCompose(originalDraft); setSkills(skills); att.setImages(images ?? []);
        throw error;
      }
    }, undefined, { id, label: deliveryMode === "queue" ? "Adding…" : "Sending…", apply: q => q.messages.some(m => m.id === id) ? q : { ...q, messages: [...q.messages, preview] } });
  }

  async function act(label: string, fn: () => Promise<unknown>, after?: () => void, preview?: QueuePreview) {
    const generation = cacheSession();
    const finish = beginTaskAction(taskId, label, preview);
    if (!finish) return;
    try {
      await fn();
      if (generation === cacheSession()) after?.();
    } catch (e) {
      if (generation !== cacheSession()) return;
      clearQueuePreview(taskId);
      toast({ title: errMsg(e), variant: "destructive" });
      // Re-read after version/lease conflicts or lost responses. Never replay a
      // send, or resurrect a queue entry already delivered by another client.
      if (preview || label === "Preparing edit…") {
        try { const actual = await api.getTask(taskId); if (actual.messageQueue) setQueueOverride(actual.messageQueue); }
        catch { /* The stream will reconcile when connectivity returns. */ }
      }
    } finally { finish(); }
  }

  async function queueAction(message: PendingMessage, action: "send" | "delete") {
    await act(action === "send" ? "Sending queued message…" : "Removing message…", async () => {
      setQueueOverride(await api.messageAction(taskId, message.id, action === "send"
        ? { action, version: message.version, expectedRunId: confirmedQueue?.runId ?? null }
        : { action, version: message.version }));
    }, undefined, { id: message.id, label: "Sending…", apply: q => ({ ...q, messages: action === "delete"
      ? q.messages.filter(m => m.id !== message.id)
      : q.messages.map(m => m.id === message.id ? { ...m, status: "sending" } : m) }) });
  }

  async function stopTurn() {
    const finish = beginTaskAction(taskId, "Stopping turn…");
    if (!finish) return;
    try {
      const actual = await api.stop(taskId);
      if (["queued", "running", "awaiting_input", "awaiting_approval"].includes(actual.status)) finishWhenStopped(taskId, finish, confirmedQueue?.runId);
      else finish();
    } catch (error) { toast({ title: errMsg(error), variant: "destructive" }); finish(); }
  }

  const heading = task ? taskTitle(task) : taskId;
  const canStop = active;
  const canCancel = running || status === "queued";
  const canArchive = !localOwner && !active && status !== "archived";

  return (
    <div className={terminalOpen ? "mx-auto flex max-w-[1600px]" : undefined}>
    <div className={terminalOpen ? "hidden min-w-0 flex-1 md:block" : "w-full"}>
    <AppShell>
      <Sheet>
        <AppBar title={heading} back conn={conn} titleControl={
          <SheetTrigger asChild>
            <Button variant="ghost" size="title" aria-label={heading} aria-description="Open session details" title="Session details">
              <span className="flex min-w-0 flex-col items-start gap-0.5">
                <span className="flex w-full min-w-0 items-center gap-1"><span className="truncate">{heading}</span><ChevronDown className="size-3.5 shrink-0" /></span>
                {task && <StatusBadge status={task.status} interrupted={task.interrupted} sessionControl={task.sessionControl} />}
              </span>
            </Button>
          </SheetTrigger>
        }>
          {task && <>
            <TaskActionsMenu task={task} busy={busy} canStop={canStop} canCancel={canCancel} canArchive={canArchive} onTerminal={() => setTerminalOpen(true)}
              onStop={() => void stopTurn()}
              onCancel={() => act("Cancelling task…", () => api.cancel(taskId))}
              onArchive={() => { void mutateTask(taskId, { hidden: true }); navigate("/"); }} />
          </>}
        </AppBar>
        <SheetContent className="max-h-[85dvh]">
          <SheetHeader><SheetTitle>Session details</SheetTitle><SheetDescription className="break-words">{heading}</SheetDescription></SheetHeader>
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-2 text-sm [overflow-wrap:anywhere]">
            {task && <div className="flex flex-wrap items-center gap-2"><AgentTag agent={task.agent} /><StatusBadge status={task.status} interrupted={task.interrupted} sessionControl={task.sessionControl} /><ConnPill conn={conn} /></div>}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
              {task?.worktreePath && <><dt>Directory</dt><dd>{task.worktreePath}</dd></>}
              {task?.branch && <><dt>Branch</dt><dd>{task.branch}</dd></>}
              {task?.model && <><dt>Model</dt><dd>{task.model}</dd></>}
              {task?.effort && <><dt>Effort</dt><dd>{task.effort}</dd></>}
              {task && <><dt>Permission</dt><dd>{permLabel(task.agent, task.permission)}</dd></>}
              {task?.sessionId && <><dt>Session</dt><dd>{task.sessionId}</dd></>}
            </dl>
            {!!task?.prs?.length && <section aria-label="Pull requests"><h3 className="text-sm font-semibold">Pull requests</h3><PrList prs={task.prs} /></section>}
            {task?.sessionId && <><Separator /><SessionHandoff task={task} /></>}
          </div>
        </SheetContent>
      </Sheet>

      <div className="flex min-h-0 flex-1 flex-col">
        {localOwner && <Alert className="mx-3 my-2 w-auto">{task?.sessionControl?.error ?? (task?.sessionControl?.owner === "returning" ? "Live preview of saved messages. Keep working in your local CLI, or close it to continue here." : "This session is controlled in a local shell. Use dispatch there to preview new messages here.")}</Alert>}

        <EventLog taskId={taskId} log={log} live={running} loading={loadingHistory}
          prompt={loadingHistory || hasEarlier ? undefined : task?.prompt}
          hasEarlier={hasEarlier} loadingEarlier={loadingEarlier} historyError={historyError} loadEarlier={loadEarlier} />

        {/* Composer + conditional answer/approval zones — plane-2 sticky footer,
            keyboard-safe (interactive-widget=resizes-content). */}
        <div ref={toastObstacle} className="flex shrink-0 flex-col gap-2 bg-background/95 px-3 pt-2.5 pb-[calc(10px+var(--safe-bottom))] backdrop-blur-md">
          {activity.label && <p role="status" className="text-xs text-muted-foreground">{activity.label}</p>}
          {task && <TaskStatusline key={taskId} taskId={taskId} agent={task.agent} />}
          {answering && task?.pendingInput && (
            <QuestionCard
              key={`${taskId}:${task.pendingInput.requestId}`}
              checkpointKey={`${taskId}:${task.pendingInput.requestId}`}
              questions={task.pendingInput.questions}
              busy={busy}
              onSubmit={(answers, skip) =>
                act(
                  skip ? "Skipping question…" : "Sending answer…",
                  () =>
                    api.answer(taskId, {
                      requestId: task.pendingInput!.requestId,
                      answers: skip ? answers.map((a) => ({ ...a, selected: [], notes: undefined })) : answers,
                    }),
                  () => toast({ title: "Answer sent", variant: "success" }),
                )
              }
            />
          )}

          {awaiting && (
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={busy}
                onClick={() => act("Approving…", () => api.approve(taskId, { decision: "approve" }))}
              >
                Approve
              </Button>
              <Button
                variant="destructive"
                className="flex-1"
                disabled={busy}
                onClick={() => act("Denying…", () => api.approve(taskId, { decision: "deny" }))}
              >
                Deny
              </Button>
            </div>
          )}

          {pendingSend && <div role="status" aria-label="Pending message" className="max-h-36 overflow-y-auto"><UserBubble text={pendingSend.text} skills={pendingSend.skills} meta={`Sending…${pendingSend.images?.length ? ` · ${pendingSend.images.length} image(s)` : ""}`} /></div>}
          {displayedQueue && <QueuePanel queue={displayedQueue} pending={activity.preview} disabled={busy || localOwner || !!edit}
            onEdit={m => void startEdit(m)}
            onSend={m => void queueAction(m, "send")}
            onDelete={m => void queueAction(m, "delete")}
            onResume={() => void act("Resuming queue…", async () => setQueueOverride(await api.resumeQueue(taskId)))} />}

          {(!answering || !!edit) && task && !localOwner && status !== "archived" && status !== "cancelled" && <Composer
            skillContext={{ taskId }} skills={edit ? editSkills : skills} onSkillsChange={edit ? setEditSkills : setSkills}
            id={`task-compose-${taskId}`} label="Message" value={edit ? editText : compose}
            onChange={edit ? setEditText : setCompose} busy={busy} disabled={!composeMode && !edit} attachments={att}
            placeholder={edit ? "Edit queued message…" : running ? "Message the agent…" : "Send a follow-up turn…"}
            action="Send now" showSettings={!edit && !(running && deliveryMode === "send")}
            onSend={() => void send()} sendDisabled={!!edit && (edit.expired || (!editText.trim() && !editSkills.length))}
            header={edit && <div className="flex w-full items-center gap-2">
              <span className="text-sm" role="status">{edit.expired ? "Edit expired — draft preserved" : "Editing queued message"}</span>
              <Button type="button" variant="ghost" size="icon-lg" className="ml-auto shrink-0" aria-label="Cancel editing" disabled={busy} onClick={() => void endEdit(false)}><X /></Button>
            </div>}
            controls={edit
              ? <Button type="button" size="icon-lg" aria-label="Save queued message" disabled={busy || edit.expired || att.preparing || (!editText.trim() && !editSkills.length)} onClick={() => void endEdit(true)}><Check /></Button>
              : <SendControl mode={deliveryMode} onMode={setDeliveryMode} onSend={() => void send()} disabled={busy}
                  sendDisabled={!composeMode || att.preparing || (!compose.trim() && att.images.length === 0 && !skills.length)} />}
            description={deliveryMode === "queue" ? "These settings are saved with the queued message." : "These settings apply to the next idle Send. Hold Send to choose Queue."}
            settings={{ agent: task.agent, model, onModelChange: setModel, effort, onEffortChange: setEffort,
              permission, onPermissionChange: setPermission }} />}
        </div>
      </div>
    </AppShell>
    </div>
    {terminalOpen && <div className="min-w-0 flex-1 md:border-l"><TerminalsView taskId={taskId} onClose={() => setTerminalOpen(false)} /></div>}
    </div>
  );
}

// Stop / Cancel / Archive collapse into one thumb-reachable overflow menu beside
// the metadata strip. Stop (reversible interrupt) fires directly; Cancel (kills
// the task + removes its worktree) and Archive open an AlertDialog confirm. The
// triggers keep their accessible names (`Stop`/`Cancel`/`Archive`) and the same
// REST call fires on confirm.
function TaskActionsMenu({
  task,
  busy,
  canStop,
  canCancel,
  canArchive,
  onStop,
  onCancel,
  onArchive,
  onTerminal,
}: {
  task: TaskState;
  busy: boolean;
  canStop: boolean;
  canCancel: boolean;
  canArchive: boolean;
  onStop: () => void;
  onCancel: () => void;
  onArchive: () => void;
  onTerminal: () => void;
}) {
  const mutationPending = useTaskMutations().get(task.taskId)?.pending;
  const [confirm, setConfirm] = useState<"cancel" | "archive" | null>(null);

  return (
    <>
      <SessionActionsMenu task={task} disabled={busy}>
        <DropdownMenuItem onSelect={onTerminal}><Terminal />Open terminal</DropdownMenuItem>
        <DropdownMenuItem disabled={!canStop || mutationPending} onSelect={onStop}>
          <Square className="text-faint" />
          Stop
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={!canCancel || mutationPending}
          onSelect={() => setConfirm("cancel")}
        >
          <Trash2 />
          Cancel
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canArchive || mutationPending} onSelect={() => setConfirm("archive")}>
          <Archive className="text-faint" />
          Archive
        </DropdownMenuItem>
      </SessionActionsMenu>

      <AlertDialog open={confirm === "cancel"} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this task?</AlertDialogTitle>
            <AlertDialogDescription>
              This kills the running turn. Its worktree is removed after any open terminals close. The work in progress
              cannot be resumed. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={onCancel}>Cancel task</AlertDialogAction>
            <AlertDialogCancel>Keep</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm === "archive"} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this task?</AlertDialogTitle>
            <AlertDialogDescription>
              Archiving removes the task from your inbox and deletes its git worktree. You won't be
              able to send further turns.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={onArchive}>Archive task</AlertDialogAction>
            <AlertDialogCancel>Keep</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
