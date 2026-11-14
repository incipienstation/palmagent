import { useRef, useState, type DragEvent } from "react";
import type { TaskState } from "@palmagent/shared";
import { ArrowDown, ArrowUp, GripVertical, MoreVertical } from "lucide-react";
import { taskTitle } from "../lib/task-title";
import { cn } from "../lib/utils";
import { moveTaskPin, useTaskMutations } from "../task-mutations";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

type Destination = { id: string; placement: "before" | "after" };
export function PinnedNavigation({ tasks, activeId, onNavigate }: {
  tasks: TaskState[]; activeId?: string; onNavigate: (id: string) => void;
}) {
  const mutations = useTaskMutations();
  const busy = tasks.some(task => mutations.get(task.taskId)?.pending);
  const dragging = useRef<string | null>(null);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const clearDrag = () => { dragging.current = null; setDestination(null); };
  const move = async (id: string, target: Destination) => {
    setAnnouncement("");
    if (await moveTaskPin(tasks, id, target.id, target.placement)) setAnnouncement("Pinned chat order saved.");
  };
  const dropTarget = (event: DragEvent<HTMLDivElement>, id: string): Destination => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { id, placement: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after" };
  };
  if (!tasks.length) return null;
  return <section aria-label="Pinned" className="px-3 pt-4">
    <h2 className="px-3 pb-2 text-xs font-medium text-muted-foreground">Pinned</h2>
    <div role="status" className="sr-only">{announcement}</div>
    {tasks.map((task, index) => <div key={task.taskId} data-pinned-task={task.taskId}
      className={cn("relative flex min-w-0 items-center rounded-xl",
        destination?.id === task.taskId && "after:pointer-events-none after:absolute after:inset-x-3 after:h-0.5 after:bg-primary",
        destination?.id === task.taskId && (destination.placement === "before" ? "after:top-0" : "after:bottom-0"))}
      onDragOver={event => {
        if (busy || !dragging.current || dragging.current === task.taskId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDestination(dropTarget(event, task.taskId));
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDestination(null);
      }}
      onDrop={event => {
        const id = dragging.current;
        if (!id || busy) return;
        event.preventDefault();
        const target = dropTarget(event, task.taskId);
        clearDrag();
        void move(id, target);
      }}>
      <Button variant={activeId === task.taskId ? "selected" : "ghost"}
        className="h-11 min-w-0 flex-1 justify-start rounded-xl px-3 text-sm font-normal"
        aria-current={activeId === task.taskId ? "page" : undefined}
        aria-description={tasks.length > 1 ? "Drag to reorder, or use the reorder menu." : undefined}
        draggable={tasks.length > 1 && !busy}
        onDragStart={event => {
          dragging.current = task.taskId;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", task.taskId);
        }}
        onDragEnd={clearDrag}
        onClick={() => onNavigate(task.taskId)}>
        <GripVertical data-icon="inline-start" className="cursor-grab" /><span className="truncate">{taskTitle(task)}</span>
      </Button>
      {tasks.length > 1 && <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-lg" aria-label={`Reorder ${taskTitle(task)}`}>
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={busy || index === 0} onSelect={() => { void move(task.taskId, { id: tasks[index - 1].taskId, placement: "before" }); }}>
              <ArrowUp />Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy || index === tasks.length - 1} onSelect={() => { void move(task.taskId, { id: tasks[index + 1].taskId, placement: "after" }); }}>
              <ArrowDown />Move down
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>}
    </div>)}
  </section>;
}
