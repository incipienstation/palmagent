import { useEffect, useMemo, useReducer, useState } from "react";
import { ArrowLeft, ArrowRight, Check, RotateCcw, Undo2, Waves, X } from "lucide-react";
import { needsTaskAttention, type TaskState, type TaskStatus } from "@palmagent/shared";
import type { ConnState } from "../../hooks/useInbox";
import { taskTitle } from "../../lib/task-title";
import { Button } from "../../components/ui/button";
import { Alert } from "../../components/ui/alert";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetHeaderRow, SheetTitle } from "../../components/ui/sheet";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { isSolved, plantName, replay } from "./engine";
import { LEVELS } from "./levels";
import { advanceProgress, freshProgress, PROGRESS_KEY, restoreProgress } from "./progress";
import { Board } from "./Board";

const taskLabels: Record<TaskStatus, string> = {
  queued: "Agent queued", running: "Agent working", awaiting_input: "Agent needs your answer",
  awaiting_approval: "Agent needs approval", idle: "Agent is idle — review the conversation",
  failed: "Task failed — review the conversation", cancelled: "Task cancelled", archived: "Task archived",
};

function readProgress() {
  try { return restoreProgress(window.localStorage.getItem(PROGRESS_KEY)); }
  catch { return freshProgress(); }
}

export function EchoGardenSheet({ open, onOpenChange, onCloseAutoFocus, tasks, taskId, conn, onReturn }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
  tasks: TaskState[];
  taskId?: string;
  conn: ConnState;
  onReturn: (taskId: string) => void;
}) {
  const [progress, dispatch] = useReducer(advanceProgress, undefined, readProgress);
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => {
    try { window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); setSaveFailed(false); }
    catch { setSaveFailed(true); }
  }, [progress]);
  const level = LEVELS[progress.level];
  const moves = progress.moves[progress.level];
  const garden = useMemo(() => replay(level, moves), [level, moves]);
  const solved = isSolved(garden);
  const [rulesOpen, setRulesOpen] = useState(false);
  const currentTask = tasks.find(task => task.taskId === taskId);
  const attention = tasks.filter(task => needsTaskAttention(task.status));
  const noticeTask = (currentTask && needsTaskAttention(currentTask.status) ? currentTask : attention[0]) ?? currentTask;
  const working = tasks.filter(task => task.status === "running" || task.status === "queued").length;
  const status = conn !== "open" ? "Reconnecting — task status may be out of date"
    : noticeTask ? taskLabels[noticeTask.status]
    : working ? `${working} ${working === 1 ? "agent" : "agents"} working` : "No active agent work";
  const blooms = garden.plants.filter(phase => phase === 2).length;

  return <Sheet open={open} onOpenChange={onOpenChange} autoFocus>
    <SheetContent size="panel" className="h-[760px]" onCloseAutoFocus={onCloseAutoFocus}>
      <SheetHeader>
        <SheetHeaderRow>
          <SheetTitle>Echo Garden</SheetTitle>
          <Button variant="ghost" size="icon-lg" aria-label="Close game" onClick={() => onOpenChange(false)}><X /></Button>
        </SheetHeaderRow>
        <SheetDescription>All plants in bloom. No echoes left.</SheetDescription>
      </SheetHeader>
      <div className="shrink-0 px-4 pt-2">
        <Alert variant={conn === "open" && noticeTask && needsTaskAttention(noticeTask.status) ? "warning" : "default"} role="status" aria-live="polite" className="flex items-center justify-between gap-2">
          <div className="min-w-0"><p>{status}</p>{noticeTask && <p className="truncate text-xs">{taskTitle(noticeTask)}</p>}</div>
          {noticeTask && <Button variant="outline" className="shrink-0" aria-label="Return to task" onClick={() => onReturn(noticeTask.taskId)}><ArrowLeft data-icon="inline-start" />Task</Button>}
        </Alert>
      </div>
      <SheetBody>
        <div className="mx-auto flex w-full max-w-[440px] flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <Select value={String(progress.level)} onValueChange={value => { if (value) dispatch({ type: "level", level: Number(value) }); }}>
              <SelectTrigger aria-label="Garden level" className="w-auto min-w-0 flex-1"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>
                {LEVELS.map((item, index) => <SelectItem key={index} value={String(index)} disabled={index >= progress.unlocked}>
                  {index + 1}. {item.title}{index >= progress.unlocked ? " · Locked" : ""}
                </SelectItem>)}
              </SelectGroup></SelectContent>
            </Select>
            <span className="shrink-0 text-xs text-muted-foreground">{progress.level + 1} / {LEVELS.length}</span>
          </div>
          <p className="min-h-10 text-sm text-muted-foreground">{level.lesson}</p>
          <Board level={level} garden={garden} solved={solved} onMove={move => dispatch({ type: "move", move })} />
          <Button variant="ghost" aria-expanded={rulesOpen} aria-controls="echo-garden-rules" onClick={() => setRulesOpen(value => !value)}>How to play</Button>
          {rulesOpen && <div id="echo-garden-rules" className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>Each tap grows a plant: Seed → Bud → Bloom → Seed. Tapping a bud into bloom sends echoes along its arrows.</p>
            <p>Your chosen plant grows first, then echoes already on their way advance. Each arrival grows its plant once, without sending another echo.</p>
            <p>Path numbers show how many more turns an echo takes. Let echoes arrive advances one turn without tapping a plant. Nothing moves while you are away.</p>
            <p>Get every plant into bloom with no pending echoes. Undo and restart are always available, with no timer or penalty. Progress is saved on this device.</p>
          </div>}
        </div>
      </SheetBody>
      <SheetFooter>
        <div className="mx-auto flex w-full max-w-[440px] flex-col gap-2">
          <div role="status" aria-live="polite" aria-atomic="true" className="flex flex-col gap-1 text-center text-sm">
            <p>{blooms} / {garden.plants.length} in bloom · {moves.length} {moves.length === 1 ? "turn" : "turns"}</p>
            <p className="min-h-5 text-xs text-muted-foreground" aria-label="Pending echoes">{garden.echoes.length
              ? garden.echoes.map(echo => `${plantName(echo.plant)} +1 ${echo.turns === 1 ? "next turn" : "in 2 turns"}`).join(" · ")
              : "No echoes on the way"}</p>
          </div>
          {solved && <Alert role="status" className="flex items-center gap-2"><Check className="size-4 shrink-0" />
            {progress.level === LEVELS.length - 1 ? "All 12 gardens complete. Revisit any level to play again." : `Garden in bloom! Level ${progress.level + 2} is unlocked.`}
          </Alert>}
          {saveFailed && <Alert variant="warning">Progress cannot be saved in this browser. Keep this tab open to continue.</Alert>}
        </div>
        <div className="mx-auto flex w-full max-w-[440px] gap-2">
          <Button variant="outline" size="icon-lg" aria-label="Undo move" disabled={!moves.length} onClick={() => dispatch({ type: "undo" })}><Undo2 /></Button>
          <Button variant="outline" size="icon-lg" aria-label="Restart level" disabled={!moves.length} onClick={() => dispatch({ type: "restart" })}><RotateCcw /></Button>
          {solved && progress.level < LEVELS.length - 1
            ? <Button className="min-w-0 flex-1" onClick={() => dispatch({ type: "level", level: progress.level + 1 })}>Next garden<ArrowRight data-icon="inline-end" /></Button>
            : <Button className="min-w-0 flex-1" variant="secondary" disabled={solved || !garden.echoes.length} onClick={() => dispatch({ type: "move", move: -1 })}><Waves data-icon="inline-start" />Let echoes arrive</Button>}
        </div>
      </SheetFooter>
    </SheetContent>
  </Sheet>;
}
