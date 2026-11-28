import type { Repo } from "@palmagent/shared";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog";

export function RemoveSpaceDialog({ repo, onClose, onConfirm, returnFocus }: {
  repo: Repo;
  onClose: () => void;
  onConfirm: () => void;
  returnFocus: () => HTMLButtonElement | null;
}) {
  return <AlertDialog open onOpenChange={open => { if (!open) onClose(); }}>
    <AlertDialogContent onCloseAutoFocus={event => {
      event.preventDefault();
      returnFocus()?.focus({ preventScroll: true });
    }}>
      <AlertDialogHeader>
        <AlertDialogTitle>Remove {repo.name} from Spaces?</AlertDialogTitle>
        <AlertDialogDescription>Its archived task history and routines will be deleted. The folder will stay on disk.</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Keep Space</AlertDialogCancel>
        <AlertDialogAction variant="destructive" onClick={onConfirm}>Remove Space</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
