import { useEffect, useState } from "react";
import type { TaskState } from "@palmagent/shared";
import { Archive, MoreVertical, Square, Trash2 } from "lucide-react";

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { api, ApiError, DEFAULT_OPTION, DEFAULT_PERMISSION, EFFORTS, MODELS, PERMISSIONS } from "../api";
import { useDraft } from "../hooks/useDraft";
import { useTaskStream } from "../hooks/useTaskStream";
import { navigate } from "../router";
import { AppBar, AppShell } from "./AppShell";
import { AttachmentTray, useImageAttachments } from "./Attachments";
import { AgentTag, StatusBadge } from "./chips";
import { PrChip } from "./PrChip";
import { EventLog } from "./EventLog";
import { QuestionCard } from "./QuestionCard";
import { SessionHandoff } from "./SessionHandoff";
import { Alert } from "./ui/alert";
import { TaskStatusline } from "./TaskStatusline";

function errMsg(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : String(e);
}

// Short label for a task's permission value (the catalog label, or the raw value
// for a legacy/unknown one). Used in the metadata strip + the composer picker.
function permLabel(agent: TaskState["agent"], value: string): string {
  return PERMISSIONS[agent].find((p) => p.value === value)?.label ?? value;
}

export function TaskDetailView({ taskId, task: inboxTask }: { taskId: string; task?: TaskState }) {
  const { log, conn, task: streamTask } = useTaskStream(taskId);
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
  // each turn. A change applies to the next turn (a steer interrupts the running
  // turn to adopt it — Claude — or queues it — Codex).
  const [model, setModel] = useState(task?.model ?? DEFAULT_OPTION);
  const [effort, setEffort] = useState(task?.effort ?? DEFAULT_OPTION);
  // Permission has no DEFAULT_OPTION (always a concrete value); clamp the task's
  // stored value to a valid option for its agent (a legacy value shows the agent
  // default in the picker). A change applies to the next turn, like model/effort.
  const [permission, setPermission] = useState<string>("");
  useEffect(() => {
    setModel(task?.model ?? DEFAULT_OPTION);
    setEffort(task?.effort ?? DEFAULT_OPTION);
    const agent = task?.agent;
    const perm = task?.permission;
    if (agent) {
      const valid = !!perm && PERMISSIONS[agent].some((p) => p.value === perm);
      setPermission(valid ? (perm as string) : DEFAULT_PERMISSION[agent]);
    }
  }, [taskId, task?.model, task?.effort, task?.permission, task?.agent]);
  const [busy, setBusy] = useState(false);
  const att = useImageAttachments((msg) => toast({ title: msg, variant: "destructive" }));

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
  const composeMode: "steer" | "followup" | null = localOwner ? null : running
    ? "steer"
    : status === "idle" || status === "failed"
      ? "followup"
      : null;

  async function send() {
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
      if (composeMode === "steer") {
        const r = await api.steer(taskId, { text, images, ...override });
        if (r.injected) {
          toast({ title: "Injected mid-turn", description: "The agent was interrupted.", variant: "success" });
        } else if (r.restarted) {
          toast({
            title: "Interrupted — resuming",
            description: "Resuming the turn with the new model/effort.",
            variant: "default",
          });
        } else {
          toast({
            title: "Queued as the next turn",
            description: "No mid-turn steer for this agent.",
            variant: "info",
          });
        }
      } else {
        await api.followup(taskId, { prompt: text, images, ...override });
      }
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

  const heading = task?.title?.trim() || task?.prompt.split("\n")[0]?.trim() || taskId;
  const canStop = active;
  const canCancel = running || status === "queued";
  const canArchive = !localOwner && !active && status !== "archived";

  return (
    <AppShell>
      <AppBar title={heading} back conn={conn} />

      <div className="flex min-h-0 flex-1 flex-col">
        {/* Metadata strip: agent/status + machine meta chips, PR link, and the
            destructive overflow menu (Stop / Cancel / Archive). The chips sit on a
            single line that scrolls horizontally *inside* this row (never wrapping,
            never widening the document) — too many chips to ever fit a phone width,
            so a swipe-able carousel beats an awkward 2-line wrap. */}
        <div className="flex items-center gap-x-3 px-4 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-x-2.5 overflow-x-auto whitespace-nowrap text-[12.5px] text-faint [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
            {task && <AgentTag agent={task.agent} />}
            {task && <StatusBadge status={task.status} interrupted={task.interrupted} />}
            {task?.branch && <span className="font-mono text-muted-foreground">{task.branch}</span>}
            {task?.model && <span>{task.model}</span>}
            {task?.effort && <span>effort {task.effort}</span>}
            {task && <span>{permLabel(task.agent, task.permission)}</span>}
            {task?.sessionId && (
              <span className="font-mono text-muted-foreground">sid {task.sessionId.slice(0, 8)}</span>
            )}
            <PrChip prs={task?.prs} />
          </div>
          <TaskActionsMenu
            busy={busy}
            canStop={canStop}
            canCancel={canCancel}
            canArchive={canArchive}
            onStop={() => act(() => api.stop(taskId))}
            onCancel={() => act(() => api.cancel(taskId))}
            onArchive={() => act(() => api.archive(taskId), () => navigate("/"))}
          />
        </div>
        {task?.sessionId && <div className="px-4 pb-2"><SessionHandoff task={task} /></div>}
        {localOwner && <Alert className="mx-4 mb-2 w-auto">{task?.sessionControl?.error ?? (task?.sessionControl?.owner === "returning" ? "Waiting for the local CLI to close and synchronize." : "This session is controlled in a local shell. Use the dispatch skill there to return it.")}</Alert>}
        <Separator />

        <EventLog log={log} live={running} prompt={task?.prompt} />

        {/* Composer + conditional answer/approval zones — plane-2 sticky footer,
            keyboard-safe (interactive-widget=resizes-content). */}
        <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-card/85 px-4 pt-2.5 pb-[calc(10px+var(--safe-bottom))] backdrop-blur-md">
          <TaskStatusline log={log} running={running} />
          {answering && task?.pendingInput && (
            <QuestionCard
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

          {/* Composer + helper collapse entirely while a question is pending
              (answering) — see the `answering` note above. The approval buttons
              live outside this branch (awaiting_approval and awaiting_input are
              mutually exclusive states, so they never both render). */}
          {!answering && (
            <>
          {/* Composer well — the textarea and its inline controls bar (model/effort
              pills + the action button) live in one rounded box that highlights as a
              whole on focus, the shadcn chat-composer idiom. Replaces the old
              short-textarea-beside-a-button layout that clipped its placeholder. */}
          <div className="flex flex-col gap-2 rounded-xl border border-input bg-background p-2 transition-colors focus-within:border-blue">
            <Textarea
              className="max-h-40 min-h-[3.25rem] resize-none border-0 bg-transparent px-1.5 py-1 focus-visible:border-0"
              value={compose}
              onChange={(e) => setCompose(e.target.value)}
              onPaste={att.onPaste}
              placeholder={
                composeMode === "steer"
                  ? "Steer the running turn… (paste images here)"
                  : composeMode === "followup"
                    ? "Send a follow-up turn… (paste images here)"
                    : status === "queued"
                      ? "Waiting for a slot…"
                      : "No further input for this task."
              }
              disabled={!composeMode || busy}
              rows={2}
            />
            {/* The three per-agent controls (model/effort/permission) ride a single
                line that scrolls horizontally inside its own rail — on a narrow phone
                they overflow rather than wrapping up above the Send button. The Send
                button stays pinned on the right, outside the scroll rail. */}
            <div className="flex items-center gap-2">
              {composeMode && task && (
                <ScrollArea className="min-w-0 flex-1 whitespace-nowrap">
                  <div className="flex w-max items-center gap-2 pb-2">
                    <Select value={model} onValueChange={(v) => v && setModel(v)} disabled={busy}>
                      <SelectTrigger
                        className="h-9 w-auto min-w-0 gap-1.5 bg-card px-2.5 text-[13px]"
                        aria-label="Model for the next turn"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MODELS[task.agent].map((m) => (
                          <SelectItem key={m.value} value={m.value}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={effort} onValueChange={(v) => v && setEffort(v)} disabled={busy}>
                      <SelectTrigger
                        className="h-9 w-auto min-w-0 gap-1.5 bg-card px-2.5 text-[13px]"
                        aria-label="Reasoning effort for the next turn"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EFFORTS[task.agent].map((eo) => (
                          <SelectItem key={eo.value} value={eo.value}>
                            {eo.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={permission} onValueChange={(v) => v && setPermission(v)} disabled={busy}>
                      <SelectTrigger
                        className="h-9 w-auto min-w-0 gap-1.5 bg-card px-2.5 text-[13px]"
                        aria-label="Permission for the next turn"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-w-[min(20rem,calc(100vw-1.25rem))]">
                        {PERMISSIONS[task.agent].map((p) => (
                          <SelectItem key={p.value} value={p.value} textValue={p.label} description={p.description}>
                            <span className={p.danger ? "text-destructive" : undefined}>{p.label}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <ScrollBar orientation="horizontal" />
                </ScrollArea>
              )}
              <Button
                className="ml-auto shrink-0"
                disabled={!composeMode || busy || att.preparing || (!compose.trim() && att.images.length === 0)}
                onClick={send}
              >
                {composeMode === "steer" ? "Steer" : "Send"}
              </Button>
            </div>
          </div>

          {composeMode && (
            <AttachmentTray
              images={att.images}
              preparing={att.preparing}
              disabled={busy}
              onAdd={(f) => void att.addFiles(f)}
              onRemove={att.remove}
            />
          )}

          <div className="text-[12.5px] text-faint">
            {composeMode === "steer"
              ? "Steer interrupts the current turn (Claude) or queues for the next (Codex)."
              : composeMode === "followup"
                ? "Resumes the session as a new turn."
                : status === "queued"
                  ? "Task is queued for a concurrency slot."
                  : " "}
          </div>
            </>
          )}
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
  busy,
  canStop,
  canCancel,
  canArchive,
  onStop,
  onCancel,
  onArchive,
}: {
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-faint"
            disabled={busy || (!canStop && !canCancel && !canArchive)}
            aria-label="Task actions"
          >
            <MoreVertical className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
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
        </DropdownMenuContent>
      </DropdownMenu>

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
