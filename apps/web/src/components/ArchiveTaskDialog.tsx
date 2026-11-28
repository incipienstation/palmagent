import type { RefObject } from "react";
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

export function ArchiveTaskDialog({ triggerRef, disabled, onArchive, onClose }: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  disabled: boolean;
  onArchive: () => void;
  onClose: () => void;
}) {
  return (
    <AlertDialog open onOpenChange={open => { if (!open) onClose(); }}>
      <AlertDialogContent onCloseAutoFocus={event => {
        event.preventDefault();
        triggerRef.current?.focus({ preventScroll: true });
      }}>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive this task?</AlertDialogTitle>
          <AlertDialogDescription>
            Archiving removes the task from your inbox and deletes its git worktree. You won't be
            able to send further turns.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={disabled} onClick={onArchive}>Archive task</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
