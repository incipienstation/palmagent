import { useUpdateState } from "../update-state";
import type { TaskState } from "@palmagent/shared";
import { RenameTaskSchema } from "@palmagent/shared/requests";
import { MoreVertical, Pencil } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { taskTitle } from "@/lib/task-title";
import { mutateTask, useTaskMutations, getRenameDraft, clearRenameDraft } from "../task-mutations";

// Both list and detail use the same editor; optional children are the detail's
// existing lifecycle actions. Keep the menu and dialog as sibling overlays.
export function SessionActionsMenu({ task, children, label = "Task actions", renameDisabled = false, triggerRef }: {
  task: TaskState;
  children?: ReactNode;
  label?: string;
  /** Keep read-only menu items available while a task action is pending. */
  renameDisabled?: boolean;
  triggerRef?: { current: HTMLButtonElement | null };
}) {
  const mutations = useTaskMutations();
  const trigger = useRef<HTMLButtonElement>(null);
  const openingEditor = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [initialTitle, setInitialTitle] = useUpdateState<string | null>(`rename:${task.taskId}:open`, null);
  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button ref={node => { trigger.current = node; if (triggerRef) triggerRef.current = node; }} variant="ghost" size="icon" className="size-11 shrink-0" aria-label={label}>
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        {/* Remove the closed menu immediately so its exit animation cannot
            restore focus after the editor has already been closed and reopened. */}
        {menuOpen && <DropdownMenuContent align="end" onCloseAutoFocus={(event) => {
          if (openingEditor.current) {
            event.preventDefault();
            openingEditor.current = false;
          }
        }}>
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={renameDisabled || mutations.get(task.taskId)?.pending} onSelect={() => {
              openingEditor.current = true;
              setInitialTitle(taskTitle(task));
            }}>
              <Pencil />
              Rename
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {children && <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>{children}</DropdownMenuGroup>
          </>}
        </DropdownMenuContent>}
      </DropdownMenu>
      {initialTitle !== null && <RenameSessionDialog
        taskId={task.taskId}
        initialTitle={initialTitle}
        onClose={() => setInitialTitle(null)}
        restoreFocus={() => trigger.current?.focus({ preventScroll: true })}
      />}
    </>
  );
}

function RenameSessionDialog({ taskId, initialTitle, onClose, restoreFocus }: {
  taskId: string;
  initialTitle: string;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const saving = useRef(false);
  const [title, setTitle] = useUpdateState(`rename:${taskId}:title`, getRenameDraft(taskId) ?? initialTitle);
  const [viewport, setViewport] = useState<{ top: number; maxHeight: number }>();
  const parsed = RenameTaskSchema.safeParse({ title });
  const valid = parsed.success && parsed.data.title !== initialTitle.trim();
  const fieldError = (!parsed.success && title.trim() ? parsed.error.issues[0]?.message : undefined);

  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual) return;
    // iOS may resize only the visual viewport when the keyboard opens.
    const update = () => setViewport({ top: visual.offsetTop + visual.height / 2, maxHeight: Math.max(0, visual.height - 32) });
    update();
    visual.addEventListener("resize", update);
    visual.addEventListener("scroll", update);
    return () => {
      visual.removeEventListener("resize", update);
      visual.removeEventListener("scroll", update);
    };
  }, []);

  async function save() {
    if (!parsed.success || !valid || saving.current) return;
    saving.current = true;
    onClose();
    // Keep the draft until acknowledgement so a failed rename can be retried.
    await mutateTask(taskId, parsed.data);
  }

  const cancel = () => { clearRenameDraft(taskId); onClose(); };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving.current) cancel(); }}>
      <DialogContent
        showClose={false}
        aria-describedby={undefined}
        className="overflow-y-auto"
        style={viewport}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const input = form.current?.querySelector("input");
          input?.focus({ preventScroll: true });
          if (window.matchMedia("(pointer: fine)").matches) input?.select();
        }}
        onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}
      >
        <DialogHeader><DialogTitle>Rename session</DialogTitle></DialogHeader>
        <form ref={form} className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <FieldGroup>
            <Field data-invalid={!!fieldError || undefined}>
              <FieldLabel htmlFor={id}>Session name</FieldLabel>
              <Input
                id={id}
                name="title"
                value={title}
                aria-invalid={!!fieldError || undefined}
                aria-describedby={fieldError ? `${id}-error` : undefined}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
                }}
              />
              {fieldError && <FieldError id={`${id}-error`}>{fieldError}</FieldError>}
            </Field>
          </FieldGroup>
          <DialogFooter className="flex-row justify-end">
            <Button type="button" variant="outline" onClick={cancel}>Cancel</Button>
            <Button type="submit" disabled={!valid}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
