import { SendControl } from "./SendControl";
import { MessageQueue as QueuePanel } from "./MessageQueue";
import type { MessageQueue, PendingMessage } from "@palmagent/shared";
import { readUpdateSnapshot, useUpdateState } from "../update-state";
import { useEffect, useRef, useState } from "react";
import type { TaskState } from "@palmagent/shared";
import { Archive, Check, ChevronDown, Square, Trash2, X } from "lucide-react";

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
import { Composer } from "./Composer";
import { AgentTag, StatusBadge } from "./chips";
import { PrList } from "./PrChip";
import { EventLog } from "./EventLog";
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
  const { log, conn, loadingHistory, hasEarlier, loadingEarlier, historyError, loadEarlier, task: streamTask } = useTaskStream(taskId);
  // Trust the scoped stream's snapshot (it's the connection that's actually live
  // while you're on this page) over the inbox-provided task, which can go stale
  // when the long-lived inbox stream freezes in the background. Fall back to the
  // inbox task for the first paint before the scoped snapshot arrives.
  const task = streamTask ?? inboxTask;
  // Per-task draft, persisted so a deploy refresh never drops an unsent steer/follow-up.
  const [compose, setCompose] = useDraft(`draft:compose:${taskId}`);
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
  const [busy, setBusy] = useState(false);
  const normalAtt = useImageAttachments((msg) => toast({ title: msg, variant: "destructive" }));
  const editAtt = useImageAttachments((msg) => toast({ title: msg, variant: "destructive" }), `queue-edit-images:${taskId}`);
  const [deliveryMode, setDeliveryMode] = usePersistedString<"send" | "queue">(`delivery:${taskId}`, "send");
  const [edit, setEdit] = useUpdateState<{ id: string; version: number; token: string; expired?: boolean } | null>(`queue-edit:${taskId}`, null);
  const [editText, setEditText] = useDraft(`draft:queue-edit:${taskId}`);
  const [submitted, setSubmitted] = useUpdateState<{ fingerprint: string; id: string } | null>(`message-request:${taskId}`, null);
  const [queueOverride, setQueueOverride] = useState<MessageQueue>();
  const remoteQueue = task?.messageQueue;
  const queue = queueOverride && queueOverride.revision > (remoteQueue?.revision ?? -1) ? queueOverride : remoteQueue;
  const att = edit ? editAtt : normalAtt;
  useEffect(() => {
    if (!edit || edit.expired) return;
    const renew = () => { void api.messageAction(taskId, edit.id, { action: "renew", token: edit.token }).then(setQueueOverride).catch(() => setEdit(current => current ? { ...current, expired: true } : current)); };
    renew(); const timer = setInterval(renew, 20_000);
    return () => clearInterval(timer);
  }, [taskId, edit?.id, edit?.token, edit?.expired]);
  async function startEdit(message: PendingMessage) {
    const token = crypto.randomUUID();
    await act(async () => {
      const q = await api.messageAction(taskId, message.id, { action: "edit", version: message.version, token });
      setQueueOverride(q); setEdit({ id: message.id, version: message.version, token });
      setEditText(message.text); editAtt.setImages(message.images ?? []);
    });
  }
  async function endEdit(save: boolean) {
    if (!edit) return;
    await act(async () => {
      if (save || !edit.expired) setQueueOverride(await api.messageAction(taskId, edit.id, save
        ? { action: "save", token: edit.token, version: edit.version, text: editText, images: editAtt.images }
        : { action: "release", token: edit.token }));
      setEdit(null); editAtt.clear(); if (save) setEditText("");
    });
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
    const text = compose.trim() || (att.images.length ? "See the attached image(s)." : "");
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
    setBusy(true);
    try {
      const request = { mode: deliveryMode, text, images, expectedRunId: queue?.runId ?? null,
        ...(running && deliveryMode === "send" ? {} : { settings: override }) };
      const fingerprint = JSON.stringify(request);
      const id = submitted?.fingerprint === fingerprint ? submitted.id : crypto.randomUUID();
      setSubmitted({ fingerprint, id });
      setQueueOverride(await api.submitMessage(taskId, { ...request, clientMessageId: id }));
      setSubmitted(null); setDeliveryMode("send");
      setCompose("");
      // Don't reset the selectors — they re-sync from the task's (possibly new)
      // model/effort via the effect above.
      att.clear();
    } catch (e) {
      toast({ title: errMsg(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    try {
      await fn();
      after?.();
    } catch (e) {
      toast({ title: errMsg(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const heading = task ? taskTitle(task) : taskId;
  const canStop = active;
  const canCancel = running || status === "queued";
  const canArchive = !localOwner && !active && status !== "archived";

  return (
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
            <TaskActionsMenu task={task} busy={busy} canStop={canStop} canCancel={canCancel} canArchive={canArchive}
              onStop={() => act(() => api.stop(taskId))}
              onCancel={() => act(() => api.cancel(taskId))}
              onArchive={() => act(() => api.archive(taskId), () => navigate("/"))} />
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

        <EventLog log={log} live={running} loading={loadingHistory}
          prompt={loadingHistory || hasEarlier ? undefined : task?.prompt}
          hasEarlier={hasEarlier} loadingEarlier={loadingEarlier} historyError={historyError} loadEarlier={loadEarlier} />

        {/* Composer + conditional answer/approval zones — plane-2 sticky footer,
            keyboard-safe (interactive-widget=resizes-content). */}
        <div className="flex shrink-0 flex-col gap-2 bg-background/95 px-3 pt-2.5 pb-[calc(10px+var(--safe-bottom))] backdrop-blur-md">
          {task && <TaskStatusline key={taskId} taskId={taskId} agent={task.agent} />}
          {answering && task?.pendingInput && (
            <QuestionCard
              key={`${taskId}:${task.pendingInput.requestId}`}
              checkpointKey={`${taskId}:${task.pendingInput.requestId}`}
              questions={task.pendingInput.questions}
              busy={busy}
              onSubmit={(answers, skip) =>
                act(
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
                onClick={() => act(() => api.approve(taskId, { decision: "approve" }))}
              >
                Approve
              </Button>
              <Button
                variant="destructive"
                className="flex-1"
                disabled={busy}
                onClick={() => act(() => api.approve(taskId, { decision: "deny" }))}
              >
                Deny
              </Button>
            </div>
          )}

          {queue && <QueuePanel queue={queue} disabled={busy || localOwner || !!edit}
            onEdit={m => void startEdit(m)}
            onSend={m => void act(async () => setQueueOverride(await api.messageAction(taskId, m.id, { action: "send", version: m.version, expectedRunId: queue.runId })))}
            onDelete={m => void act(async () => setQueueOverride(await api.messageAction(taskId, m.id, { action: "delete", version: m.version })))}
            onResume={() => void act(async () => setQueueOverride(await api.resumeQueue(taskId)))} />}

          {(!answering || !!edit) && task && !localOwner && status !== "archived" && status !== "cancelled" && <Composer
            id={`task-compose-${taskId}`} label="Message" value={edit ? editText : compose}
            onChange={edit ? setEditText : setCompose} busy={busy} disabled={!composeMode && !edit} attachments={att}
            placeholder={edit ? "Edit queued message…" : running ? "Message the agent…" : "Send a follow-up turn…"}
            action="Send now" showSettings={!edit && !(running && deliveryMode === "send")}
            header={edit && <div className="flex w-full items-center gap-2">
              <span className="text-sm" role="status">{edit.expired ? "Edit expired — draft preserved" : "Editing queued message"}</span>
              <Button type="button" variant="ghost" size="icon-lg" className="ml-auto shrink-0" aria-label="Cancel editing" disabled={busy} onClick={() => void endEdit(false)}><X /></Button>
            </div>}
            controls={edit
              ? <Button type="button" size="icon-lg" aria-label="Save queued message" disabled={busy || edit.expired || att.preparing || !editText.trim()} onClick={() => void endEdit(true)}><Check /></Button>
              : <SendControl mode={deliveryMode} onMode={setDeliveryMode} onSend={() => void send()} disabled={busy}
                  sendDisabled={!composeMode || att.preparing || (!compose.trim() && att.images.length === 0)} />}
            description={deliveryMode === "queue" ? "These settings are saved with the queued message." : "These settings apply to the next idle Send. Hold Send to choose Queue."}
            settings={{ agent: task.agent, model, onModelChange: setModel, effort, onEffortChange: setEffort,
              permission, onPermissionChange: setPermission }} />}
        </div>
      </div>
    </AppShell>
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
}: {
  task: TaskState;
  busy: boolean;
  canStop: boolean;
  canCancel: boolean;
  canArchive: boolean;
  onStop: () => void;
  onCancel: () => void;
  onArchive: () => void;
}) {
  const [confirm, setConfirm] = useState<"cancel" | "archive" | null>(null);

  return (
    <>
      <SessionActionsMenu task={task} disabled={busy}>
        <DropdownMenuItem disabled={!canStop} onSelect={onStop}>
          <Square className="text-faint" />
          Stop
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={!canCancel}
          onSelect={() => setConfirm("cancel")}
        >
          <Trash2 />
          Cancel
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canArchive} onSelect={() => setConfirm("archive")}>
          <Archive className="text-faint" />
          Archive
        </DropdownMenuItem>
      </SessionActionsMenu>

      <AlertDialog open={confirm === "cancel"} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this task?</AlertDialogTitle>
            <AlertDialogDescription>
              This kills the running turn and removes the task's git worktree. The work in progress
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
