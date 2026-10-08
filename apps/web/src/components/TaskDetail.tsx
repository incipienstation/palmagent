import { useContextCompaction } from "../hooks/useContextCompaction";
import { useNewChat } from "../hooks/useNewChat";
import { useTaskComposer } from "../hooks/useTaskComposer";
import { isSendingAction } from "../task-activity";
import { useBackLayer } from "../hooks/useBackLayer";
import { TerminalsView } from "./Terminals";
import { stopTaskTurn } from "../task-stop";
import { mutateTask, useTaskMutations } from "../task-mutations";
import { useToastObstacle } from "../hooks/useToastObstacle";
import { SendControl } from "./SendControl";
import { MessageQueue as QueuePanel } from "./MessageQueue";
import { useUpdateState } from "../update-state";
import { useRef, useState } from "react";
import type { TaskState } from "@palmagent/shared";
import { Archive, Check, Minimize2, Gamepad2, Info, SquarePen, Trash2, X, Terminal } from "lucide-react";
import { useAppNavigation } from "./AppNavigation";

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
import { useTaskStream } from "../hooks/useTaskStream";
import { newTaskPath } from "../space-context";
import { navigate } from "../router";
import { AppBar, AppShell, ConnPill } from "./AppShell";
import { Composer } from "./Composer";
import { permissionLabel } from "./PermissionPicker";
import { AgentTag, StatusBadge } from "./chips";
import { PrList } from "./PrChip";
import { EventLog } from "./EventLog";
import { QuestionCard } from "./QuestionCard";
import { ApprovalCard } from "./ApprovalCard";
import { SessionHandoff } from "./SessionHandoff";
import { Alert } from "./ui/alert";
import { SessionActionsMenu } from "./SessionActionsMenu";
import { taskTitle } from "@/lib/task-title";
import { TaskStatusline } from "./TaskStatusline";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "./ui/sheet";

export function TaskDetailView({ taskId: existingId, task: inboxTask, onCreated, initialRepoId }: { initialRepoId?: string; taskId?: string; task?: TaskState; onCreated?: (task: TaskState) => void }) {
  const taskId = existingId ?? "new";
  const navigation = useAppNavigation();
  const creating = !existingId;
  const newChat = useNewChat(creating, onCreated, initialRepoId);
  const [terminalOpen, setTerminalOpen] = useUpdateState(`task:${taskId}:terminal-open`, false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const taskActionsTrigger = useRef<HTMLButtonElement>(null);
  useBackLayer(terminalOpen, () => setTerminalOpen(false));
  const toastObstacle = useToastObstacle();
  const { log, conn, history, task: streamTask } = useTaskStream(taskId, !creating);
  // Trust the scoped stream's snapshot (it's the connection that's actually live
  // while you're on this page) over the inbox-provided task, which can go stale
  // when the long-lived inbox stream freezes in the background. Fall back to the
  // inbox task for the first paint before the scoped snapshot arrives.
  const task = streamTask ?? inboxTask;
  const {
    activity, busy, compose, setCompose, skills, setSkills, editSkills, setEditSkills,
    edit, editText, setEditText, att, deliveryMode, setDeliveryMode, confirmedQueue,
    queue, pendingDeliveries, displayedQueue, resumeDisabled, localOwner, status,
    running, placeholder, awaiting, answering, composeMode, settingsReadOnly, displayedModel,
    displayedEffort, setModel, setEffort, permission, setPermission, primaryAction,
    canCancel, canArchive, startEdit, endEdit, send, queueAction, cancel, resume, answer, approve,
  } = useTaskComposer(taskId, task);
  const compaction = useContextCompaction(task, confirmedQueue, busy || !!edit, () => setCompose(current => current.trim() === "/compact" ? "" : current));
  const submit = () => {
    if (!edit && compose.trim() === "/compact") { compaction.request("command"); return; }
    void send();
  };
  const heading = creating ? "New task" : task ? taskTitle(task) : "Conversation";
  const showingFirstMessage = !!newChat.preview && !history.earlier.hasMore && !log.some(item => item.kind === "status" && (item.event.payload as { subtype?: string })?.subtype === "dispatch");

  return (
    <div className={terminalOpen ? "mx-auto flex max-w-[1600px]" : undefined}>
    <div className={terminalOpen ? "hidden min-w-0 flex-1 md:block" : "w-full"}>
    <AppShell>
      <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
        <AppBar title={heading} conn={creating ? undefined : conn} conversation>
          {navigation?.openGame && <Button variant="ghost" size="icon-lg" aria-label="Open Scrap Survivor" title="Scrap Survivor" onClick={event => navigation.openGame?.(event.currentTarget)}><Gamepad2 /></Button>}
          <Button variant="ghost" size="icon-lg" className="pointer-events-auto touch-pan-y" aria-label="New task" title="New task" onClick={() => navigate(newTaskPath(task?.repoId ?? initialRepoId))}>
            <SquarePen />
          </Button>
          {task && <>
            <TaskActionsMenu task={task} busy={busy} canCancel={canCancel} canArchive={canArchive} triggerRef={taskActionsTrigger} onTerminal={() => setTerminalOpen(true)}
              onDetails={() => setDetailsOpen(true)} onCompact={() => compaction.request()} compactReason={compaction.unavailable}
              onCancel={() => void cancel()}
              onArchive={() => { void mutateTask(taskId, { hidden: true }); navigate("/"); }} />
          </>}
        </AppBar>
        <SheetContent onCloseAutoFocus={event => {
          event.preventDefault();
          taskActionsTrigger.current?.focus({ preventScroll: true });
        }}>
          <SheetHeader><SheetTitle>Session details</SheetTitle><SheetDescription className="break-words">{heading}</SheetDescription></SheetHeader>
          <SheetBody className="flex flex-col gap-4 text-sm [overflow-wrap:anywhere]">
            {task && <div className="flex flex-wrap items-center gap-2"><AgentTag agent={task.agent} /><StatusBadge status={task.status} interrupted={task.interrupted} sessionControl={task.sessionControl} /><ConnPill conn={conn} /></div>}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
              {task?.worktreePath && <><dt>Directory</dt><dd>{task.worktreePath}</dd></>}
              {task?.branch && <><dt>Branch</dt><dd>{task.branch}</dd></>}
              {task?.model && <><dt>Model</dt><dd>{task.model}</dd></>}
              {task?.effort && <><dt>Effort</dt><dd>{task.effort}</dd></>}
              {task && <><dt>Permission</dt><dd>{permissionLabel(task.agent, task.permission)}</dd></>}
              {task?.sessionId && <><dt>Session</dt><dd>{task.sessionId}</dd></>}
            </dl>
            {!!task?.prs?.length && <section aria-label="Pull requests"><h3 className="text-sm font-semibold">Pull requests</h3><PrList prs={task.prs} /></section>}
            {task?.sessionId && <><Separator /><SessionHandoff task={task} /></>}
          </SheetBody>
        </SheetContent>
      </Sheet>

      <AlertDialog open={compaction.intro !== null} onOpenChange={open => { if (!open) compaction.closeIntro(); }}>
        <AlertDialogContent onCloseAutoFocus={event => {
          event.preventDefault();
          const target = compaction.source.current === "command" ? document.getElementById(`task-compose-${taskId}`) : taskActionsTrigger.current;
          target?.focus({ preventScroll: true });
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>Compact context?</AlertDialogTitle>
            <AlertDialogDescription>Summarize earlier messages to free context space. Some details may be omitted from the model’s context. Your visible conversation and draft stay in place.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction variant="default" disabled={!!compaction.unavailable} onClick={compaction.confirm}>Compact context</AlertDialogAction>
            <AlertDialogCancel>Not now</AlertDialogCancel>
          </AlertDialogFooter>
          {compaction.unavailable && <p role="status" className="text-sm text-muted-foreground">{compaction.unavailable}</p>}
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex min-h-0 flex-1 flex-col">
        {localOwner && <Alert className="mx-3 my-2 w-auto">{task?.sessionControl?.error ?? (task?.sessionControl?.owner === "returning" ? "Live preview of saved messages. Keep working in your local CLI, or close it to continue here." : "This session is controlled in a local shell. Use dispatch there to preview new messages here.")}</Alert>}

        <EventLog taskId={existingId} log={log} live={running && !compaction.running} blocked={status === "awaiting_input" || status === "awaiting_approval"} history={history}
          empty={creating ? <p className="text-center font-sans text-lg text-muted-foreground">What should we work on?</p> : undefined}
          prompt={showingFirstMessage ? undefined : task?.prompt}
          delivery={creating ? newChat.delivery : { messages: [...(showingFirstMessage ? newChat.delivery.messages : []), ...pendingDeliveries], paused: queue?.paused ?? false, disabled: busy || localOwner || !!edit,
            resumeDisabled, onDelete: m => void queueAction(m, "delete"),
            onResume: () => void resume(true) }} />

        {/* Composer + conditional answer/approval zones — plane-2 sticky footer,
            keyboard-safe (interactive-widget=resizes-content). */}
        <div ref={toastObstacle} className="relative flex shrink-0 flex-col gap-2 bg-background/95 px-3 pt-2.5 pb-[calc(10px+var(--safe-bottom))] backdrop-blur-md">
          <div className="pointer-events-none absolute inset-x-3 top-0 h-4 overflow-hidden" aria-live="polite">
            {(compaction.running || activity.label && !isSendingAction(activity.kind)) &&
              <p role="status" className="truncate text-xs leading-4 text-muted-foreground">{activity.label ?? (status === "queued" ? "Waiting to compact context…" : "Compacting context…")}</p>}
          </div>
          {compaction.error && !creating && <Alert className="flex items-center gap-2" role="alert">
            <span className="min-w-0 flex-1 break-words text-sm">{compaction.error}</span>
            <Button variant="ghost" size="sm" disabled={!!compaction.unavailable} onClick={compaction.retry}>Retry</Button>
          </Alert>}
          {creating && newChat.notices}
          {creating ? newChat.workspace : task && <TaskStatusline key={taskId} taskId={taskId} agent={task.agent} />}
          {answering && task?.pendingInput && (
            <QuestionCard
              key={`${taskId}:${task.pendingInput.requestId}`}
              checkpointKey={`${taskId}:${task.pendingInput.requestId}`}
              questions={task.pendingInput.questions}
              busy={busy}
              onSubmit={(answers, skip) => answer({ requestId: task.pendingInput!.requestId, answers }, !!skip)}
            />
          )}

          {awaiting && (
            <ApprovalCard request={task?.pendingApproval} busy={busy} onDecision={decision => void approve(decision)} />
          )}

          {displayedQueue && <QueuePanel queue={displayedQueue} pending={activity.preview} disabled={busy || localOwner || !!edit} resumeDisabled={resumeDisabled}
            onEdit={m => void startEdit(m)}
            onSend={m => void queueAction(m, "send")}
            onDelete={m => void queueAction(m, "delete")}
            onResume={() => void resume()} />}

          {(creating || !localOwner && status !== "archived" && status !== "cancelled") && (creating ? <Composer {...newChat.composer} /> : <Composer
            skillContext={{ taskId }} skills={edit ? editSkills : skills} onSkillsChange={edit ? setEditSkills : setSkills}
            voiceScope={`${taskId}:${edit?.id ?? "draft"}`} id={`task-compose-${taskId}`} label="Message" value={edit ? editText : compose}
            onChange={edit ? setEditText : setCompose} busy={busy} disabled={!composeMode && !edit && !compaction.running} attachments={att}
            placeholder={placeholder}
            onStop={primaryAction === "stop" ? () => void stopTaskTurn(taskId, confirmedQueue?.runId) : undefined} stopping={!!activity.stopping}
            action="Send now" settingsReadOnly={settingsReadOnly}
            onSend={submit} sendDisabled={!!edit && (edit.expired || (!editText.trim() && !editSkills.length))}
            commandActive={!edit && compose.trim() === "/compact"}
            header={edit && <div className="flex w-full items-center gap-2">
              <span className="text-sm" role="status">{edit.expired ? "Edit expired — draft preserved" : "Editing queued message"}</span>
              <Button type="button" variant="ghost" size="icon-lg" className="ml-auto shrink-0" aria-label="Cancel editing" disabled={busy} onClick={() => void endEdit(false)}><X /></Button>
            </div>}
            controls={edit
              ? <Button type="button" size="icon-lg" aria-label="Save queued message" disabled={busy || edit.expired || att.preparing || (!editText.trim() && !editSkills.length)} onClick={() => void endEdit(true)}><Check /></Button>
              : primaryAction === "send" ? <SendControl mode={deliveryMode} onMode={setDeliveryMode} onSend={submit} disabled={busy}
                  sendDisabled={!composeMode || att.preparing || (!compose.trim() && att.images.length === 0 && !skills.length)} /> : undefined}
            description={deliveryMode === "queue" ? "These settings are saved with the queued message." : "These settings apply to the next idle Send. Hold Send to choose Queue."}
            settings={{ agent: task?.agent ?? "claude", model: displayedModel, onModelChange: setModel, effort: displayedEffort, onEffortChange: setEffort,
              permission, onPermissionChange: setPermission }} />)}
        </div>
      </div>
      {creating && newChat.picker}
    </AppShell>
    </div>
    {terminalOpen && <div className="min-w-0 flex-1 md:border-l"><TerminalsView taskId={taskId} onClose={() => setTerminalOpen(false)} /></div>}
    </div>
  );
}

// Destructive lifecycle actions stay in the overflow menu; Stop lives in the composer.
function TaskActionsMenu({
  task,
  busy,
  canCancel,
  canArchive,
  triggerRef,
  onDetails,
  onCancel,
  onArchive,
  onTerminal,
  onCompact,
  compactReason,
}: {
  task: TaskState;
  busy: boolean;
  canCancel: boolean;
  canArchive: boolean;
  triggerRef: { current: HTMLButtonElement | null };
  onDetails: () => void;
  onCancel: () => void;
  onArchive: () => void;
  onTerminal: () => void;
  onCompact: () => void;
  compactReason?: string;
}) {
  const mutationPending = useTaskMutations().get(task.taskId)?.pending;
  const [confirm, setConfirm] = useState<"cancel" | "archive" | null>(null);

  return (
    <>
      <SessionActionsMenu task={task} renameDisabled={busy} triggerRef={triggerRef} lifecycle={<>
        <DropdownMenuItem disabled={busy || !canArchive || mutationPending} onSelect={() => setConfirm("archive")}>
          <Archive />Archive
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" disabled={busy || !canCancel || mutationPending} onSelect={() => setConfirm("cancel")}>
          <Trash2 />Cancel…
        </DropdownMenuItem>
      </>}>
        {task.agent === "codex" && <DropdownMenuItem disabled={!!compactReason} onSelect={onCompact}>
          <Minimize2 />
          <span className="flex min-w-0 flex-col">
            <span>Compact context</span>
            {compactReason && <span className="max-w-56 whitespace-normal text-xs text-muted-foreground">{compactReason}</span>}
          </span>
        </DropdownMenuItem>}
        <DropdownMenuItem disabled={busy} onSelect={onTerminal}><Terminal />Open terminal</DropdownMenuItem>
        <DropdownMenuItem onSelect={onDetails}><Info />Session details</DropdownMenuItem>
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
            <AlertDialogAction variant="destructive" onClick={onCancel}>Cancel task</AlertDialogAction>
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
            <AlertDialogAction variant="destructive" onClick={onArchive}>Archive task</AlertDialogAction>
            <AlertDialogCancel>Keep</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
