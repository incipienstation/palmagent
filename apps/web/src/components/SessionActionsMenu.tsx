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
import { api } from "../api";

// Both list and detail use the same editor; optional children are the detail's
// existing lifecycle actions. Keep the menu and dialog as sibling overlays.
export function SessionActionsMenu({ task, children, label = "Task actions", disabled = false }: {
  task: TaskState;
  children?: ReactNode;
  label?: string;
  disabled?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const openingEditor = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [initialTitle, setInitialTitle] = useUpdateState<string | null>(`rename:${task.taskId}:open`, null);
  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button ref={trigger} variant="ghost" size="icon" className="size-11 shrink-0" aria-label={label} disabled={disabled}>
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
            <DropdownMenuItem onSelect={() => {
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
  const [title, setTitle] = useUpdateState(`rename:${taskId}:title`, initialTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [viewport, setViewport] = useState<{ top: number; maxHeight: number }>();
  const parsed = RenameTaskSchema.safeParse({ title });
  const valid = parsed.success && parsed.data.title !== initialTitle.trim();
  const fieldError = error || (!parsed.success && title.trim() ? parsed.error.issues[0]?.message : undefined);

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
    setBusy(true);
    setError(undefined);
    try {
      await api.renameTask(taskId, parsed.data);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't rename this session. Try again.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving.current) onClose(); }}>
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
                disabled={busy}
                aria-invalid={!!fieldError || undefined}
                aria-describedby={fieldError ? `${id}-error` : undefined}
                onChange={(event) => { setTitle(event.target.value); setError(undefined); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
                }}
              />
              {fieldError && <FieldError id={`${id}-error`}>{fieldError}</FieldError>}
            </Field>
          </FieldGroup>
          <DialogFooter className="flex-row justify-end">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !valid}>{busy ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
