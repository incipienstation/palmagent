import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Crosshair, RotateCcw, X, Zap } from "lucide-react";
import { needsTaskAttention, type TaskState, type TaskStatus } from "@palmagent/shared";
import type { ConnState } from "../../hooks/useInbox";
import { taskTitle } from "../../lib/task-title";
import { Button } from "../../components/ui/button";
import { Alert } from "../../components/ui/alert";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetHeaderRow, SheetTitle } from "../../components/ui/sheet";
import { cleared, enemies, fire, freshRun, restoreRun, ROOM_NAMES, SAVE_KEY, takeUpgrade, UPGRADES, won, type Run, type Upgrade } from "./engine";
import type { Arena } from "./scene";
import { cn } from "../../lib/utils";

const labels: Record<TaskStatus, string> = { queued: "Agent queued", running: "Agent working", awaiting_input: "Agent needs your answer",
  awaiting_approval: "Agent needs approval", idle: "Agent is idle", failed: "Task failed", cancelled: "Task cancelled", archived: "Task archived" };
function readRun() { try { return restoreRun(localStorage.getItem(SAVE_KEY)); } catch { return freshRun(); } }

export function ScrapScoutSheet({ open, onOpenChange, onCloseAutoFocus, tasks, taskId, conn, onReturn }: {
  open: boolean; onOpenChange: (open: boolean) => void; onCloseAutoFocus: (event: Event) => void;
  tasks: TaskState[]; taskId?: string; conn: ConnState; onReturn: (id: string) => void;
}) {
  const [run, setRun] = useState(readRun), [aim, setAim] = useState(0), [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false), [restart, setRestart] = useState(false);
  const [report, setReport] = useState("Aim at an energy barrel to start a chain reaction.");
  const host = useRef<HTMLDivElement>(null), arena = useRef<Arena | null>(null), pending = useRef<Run | null>(null);
  const current = useRef(run), angle = useRef(aim); current.current = run; angle.current = aim;
  const save = (value: Run) => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(value)); setSaveFailed(false); } catch { setSaveFailed(true); } };
  useEffect(() => { save(run); arena.current?.sync(run, angle.current); }, [run]);
  useEffect(() => { arena.current?.sync(current.current, aim); }, [aim]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false, dispose: (() => void) | undefined;
    setReady(false); setError(false);
    // The engine and sprites are loaded only after the player explicitly opens the game.
    import("./scene").then(({ createArena }) => {
      if (cancelled || !host.current) return;
      dispose = createArena(host.current, current.current, setAim, value => {
        if (cancelled) return;
        arena.current = value; setReady(Boolean(value)); setError(!value);
        value?.sync(current.current, angle.current);
      });
    }).catch(() => { if (!cancelled) setError(true); });
    return () => {
      cancelled = true; arena.current = null; dispose?.();
      // A launched shot is committed atomically; closing skips its remaining animation.
      if (pending.current) { setRun(pending.current); pending.current = null; }
      setBusy(false); setReady(false);
    };
  }, [open, attempt]);
  const shoot = () => {
    if (!arena.current || busy || cleared(run) || run.hull <= 0) return;
    const result = fire(run, aim);
    if (!result.frames.length) return;
    pending.current = result.run; save(result.run); setBusy(true);
    setReport(`${result.hits} impacts · ${result.kills} enemies cleared${result.run.hull < run.hull ? " · enemy retaliation" : ""}`);
    arena.current.play(result.frames, () => { pending.current = null; setRun(result.run); setBusy(false); });
  };
  const scrollToBoard = () => host.current?.closest('[data-slot="scroll-area-viewport"]')?.scrollTo({ top: 0 });
  const choose = (upgrade: Upgrade) => { setRun(takeUpgrade(run, upgrade)); setAim(0); setReport(`${UPGRADES[upgrade].name} installed. Hull restored.`); scrollToBoard(); };
  const reset = () => { setRun(freshRun()); setAim(0); setRestart(false); setReport("Aim at an energy barrel to start a chain reaction."); };
  const currentTask = tasks.find(t => t.taskId === taskId);
  const notice = (currentTask && needsTaskAttention(currentTask.status) ? currentTask : tasks.find(t => needsTaskAttention(t.status))) ?? currentTask;
  const status = conn !== "open" ? "Reconnecting — task status may be out of date" : notice ? labels[notice.status] : "Ready when you are";
  const complete = cleared(run), defeated = run.hull <= 0;

  return <Sheet open={open} onOpenChange={onOpenChange} autoFocus>
    <SheetContent size="panel" className="h-[850px]" onCloseAutoFocus={onCloseAutoFocus}>
      <SheetHeader>
        <SheetHeaderRow><SheetTitle>Scrap Scout</SheetTitle><Button variant="ghost" size="icon-lg" aria-label="Close game" onClick={() => onOpenChange(false)}><X /></Button></SheetHeaderRow>
        <SheetDescription>Ricochet. Chain react. Build your next shot.</SheetDescription>
      </SheetHeader>
      <div className="shrink-0 px-4 pt-2">
        <Alert role="status" variant={notice && needsTaskAttention(notice.status) ? "warning" : "default"} className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate" title={notice ? taskTitle(notice) : undefined}>{status}</p>
          {notice && <Button variant="outline" size="sm" aria-label="Return to task" onClick={() => onReturn(notice.taskId)}><ArrowLeft data-icon="inline-start" />Task</Button>}
        </Alert>
      </div>
      <SheetBody>
        <div className="mx-auto flex w-full max-w-[420px] flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><strong>{run.room + 1} / 4 · {ROOM_NAMES[run.room]}</strong><span aria-label="Hull">Hull {run.hull} / 7</span></div>
          <div ref={host} role="img" aria-label={`Scrap Scout arena. ${enemies(run).length} enemies remain. Aim using the angle control and Fire button.`}
            data-testid="scrap-arena" data-vaul-no-drag className={cn("relative w-full overflow-hidden rounded-xl bg-muted touch-none", !busy && (complete || defeated) ? "h-40" : "h-[min(48dvh,440px)] min-h-[240px]")} />
          {!ready && !error && <p role="status" className="text-sm text-muted-foreground">Loading the scrapyard…</p>}
          {error && <Alert variant="warning">The game could not load. <Button variant="outline" size="sm" onClick={() => setAttempt(a => a + 1)}>Retry game</Button></Alert>}
          {saveFailed && <Alert variant="warning">Progress could not be saved. Keep this tab open.</Alert>}
          {!busy && complete && !won(run) && <section aria-label="Choose an upgrade" className="flex flex-col gap-2">
            <h3 className="text-center font-semibold">Room cleared · Choose an upgrade</h3>
            <div className="grid grid-cols-2 gap-2">{(Object.keys(UPGRADES) as Upgrade[]).map(key => <Button key={key} variant="outline" className="h-auto min-h-24 flex-col items-start whitespace-normal p-3 text-left" onClick={() => choose(key)}>
              <span>{UPGRADES[key].name}</span><span className="text-xs text-muted-foreground">{UPGRADES[key].detail}</span>
            </Button>)}</div>
          </section>}
          {!busy && (won(run) || defeated) && <Alert role="status"><strong>{won(run) ? "Warden defeated. Expedition complete!" : "Hull depleted. Try a different build."}</strong><p>{run.total} shots fired.</p><Button className="mt-2" onClick={reset}>New expedition</Button></Alert>}
          {!!run.upgrades.length && <p className="text-xs text-muted-foreground">Build: {run.upgrades.map(u => UPGRADES[u].name).join(" · ")}</p>}
          <details className="text-sm text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">How to play</summary>
            <p>Aim on the board or adjust the angle, then fire. Orbs bounce off walls and armor. Orange barrels explode into nearby targets. Clear all enemies to choose an upgrade and repair one hull.</p>
            <p className="mt-2">Surviving enemies retaliate every second shot (2 hull in the boss room). Aiming has no timer. Closing finishes the current shot and saves its result. Four rooms complete the prototype.</p>
          </details>
        </div>
      </SheetBody>
      <SheetFooter>
        <div className="mx-auto flex w-full max-w-[420px] flex-col gap-2">
          <p role="status" aria-live="polite" className="text-center text-xs text-muted-foreground">{busy ? "Shot in flight…" : report}</p>
          {!complete && !defeated && <>
            <label className="flex items-center gap-3 text-sm" data-vaul-no-drag><Crosshair className="size-4" /><span>Aim</span>
              <input aria-label="Aim angle" type="range" min="-72" max="72" step="1" value={aim} disabled={busy} onChange={e => setAim(Number(e.target.value))} className="h-11 min-w-0 flex-1 accent-primary" /><span className="w-10 text-right tabular-nums">{aim}°</span>
            </label>
            <div className="flex items-center gap-2"><Button variant="outline" size="icon-lg" aria-label="Restart expedition" disabled={busy} onClick={() => setRestart(true)}><RotateCcw /></Button>
              <Button className="flex-1" disabled={!ready || busy} onClick={shoot}><Zap data-icon="inline-start" />{busy ? "Ricocheting…" : "Fire"}</Button></div>
            <p className="text-center text-xs text-muted-foreground">{run.shots % 2 === 0 ? "Retaliation in 2 shots" : "Enemies retaliate after this shot"}</p>
          </>}
          {restart && <Alert><p>Start over from room 1?</p><div className="mt-2 flex gap-2"><Button variant="outline" onClick={() => setRestart(false)}>Keep playing</Button><Button onClick={reset}>Restart</Button></div></Alert>}
        </div>
      </SheetFooter>
    </SheetContent>
  </Sheet>;
}
