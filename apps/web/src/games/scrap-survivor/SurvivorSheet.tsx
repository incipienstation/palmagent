import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Pause, Play, RotateCcw, X } from "lucide-react";
import { needsTaskAttention, type TaskState } from "@palmagent/shared";
import type { ConnState } from "../../hooks/useInbox";
import type { GameDelivery } from "../play-events";
import { Button } from "../../components/ui/button";
import { Alert } from "../../components/ui/alert";
import { Sheet, SheetContent, SheetHeader, SheetHeaderRow, SheetTitle, SheetDescription } from "../../components/ui/sheet";
import { chooseUpgrade, freshRun, restore, serialize, SAVE_KEY, UPGRADES, type Point, type Run, type Upgrade } from "./engine";

import { MovementJoystick } from "./MovementJoystick";

const read = () => { try { return restore(localStorage.getItem(SAVE_KEY)); } catch { return freshRun(); } };
const snapshot = (r: Run) => ({ time: r.time, hull: r.hull, level: r.level, xp: r.xp, nextXp: r.nextXp, kills: r.kills, won: r.won, boss: r.boss, choices: [...r.choices], upgrades: { ...r.upgrades } });
const directions = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] } as const;
export function SurvivorSheet({ open, onOpenChange, onCloseAutoFocus, tasks, taskId, delivery, conn, onReturn }: {
  open: boolean; onOpenChange: (open: boolean) => void; onCloseAutoFocus: (event: Event) => void;
  tasks: TaskState[]; taskId?: string; delivery?: GameDelivery; conn: ConnState; onReturn: (id?: string) => void;
}) {
  const run = useRef<Run | null>(null); if (!run.current) run.current = read();
  const [hud, setHud] = useState(() => snapshot(run.current!));
  const [pause, setPause] = useState("");
  const [ready, setReady] = useState(false), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false), [restart, setRestart] = useState(false);
  const [ack, setAck] = useState("");
  const host = useRef<HTMLDivElement>(null), keys = useRef(new Set<string>()), pointer = useRef<Point>({ x: 0, y: 0 });
  const movePointer = useCallback((point: Point) => { pointer.current = point; }, []);
  const task = tasks.find(t => t.taskId === taskId);
  const attention = task && needsTaskAttention(task.status) ? `${task.taskId}:${task.status}:${JSON.stringify(task.pendingInput ?? task.pendingApproval)}` : "";
  const failed = delivery?.state === "failed";
  const reason = failed ? "Message delivery needs attention" : attention && attention !== ack ? "Your agent needs attention" : pause;
  const stopped = !open || !ready || Boolean(reason) || restart || hud.choices.length > 0 || hud.hull <= 0 || hud.won;
  const stoppedRef = useRef(stopped); stoppedRef.current = stopped;
  const refresh = () => setHud(snapshot(run.current!));
  const save = () => { try { localStorage.setItem(SAVE_KEY, serialize(run.current!)); setSaveFailed(false); } catch { setSaveFailed(true); } };
  const clearInput = () => { keys.current.clear(); pointer.current = { x: 0, y: 0 }; };
  useEffect(() => { if (stopped) clearInput(); }, [stopped]);
  useEffect(() => {
    if (!open) return;
    if (delivery?.state === "sending" && (run.current!.won || run.current!.hull <= 0)) { run.current = freshRun(); refresh(); }
    setPause(document.hidden ? "Paused while away" : ""); setAck(""); setRestart(false);
  }, [open, delivery?.id]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false, dispose: (() => void) | undefined;
    setReady(false); setError(false);
    import("./scene").then(({ createArena }) => {
      if (cancelled || !host.current) return;
      dispose = createArena(host.current, () => run.current!, () => {
        let { x, y } = pointer.current;
        for (const key of keys.current) { const vector = directions[key as keyof typeof directions]; if (vector) { x += vector[0]; y += vector[1]; } }
        return { x, y };
      }, () => stoppedRef.current, refresh, value => { if (!cancelled) { setReady(value); setError(!value); } });
    }).catch(() => { if (!cancelled) setError(true); });
    const checkpoint = setInterval(save, 1000);
    const blur = () => { clearInput(); setPause("Paused while away"); save(); };
    const visibility = () => { if (document.hidden) blur(); };
    const keyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable="true"]')) return;
      if (directions[event.code as keyof typeof directions] && !stoppedRef.current) { event.preventDefault(); keys.current.add(event.code); }
    };
    const keyUp = (event: KeyboardEvent) => keys.current.delete(event.code);
    window.addEventListener("keydown", keyDown); window.addEventListener("keyup", keyUp); window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility); window.addEventListener("pagehide", blur);
    return () => {
      cancelled = true; clearInterval(checkpoint); clearInput(); save(); dispose?.(); setReady(false);
      window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp); window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", blur);
    };
  }, [open, attempt]);
  const choose = (key: Upgrade) => { chooseUpgrade(run.current!, key); refresh(); save(); };
  const reset = () => { run.current = freshRun(); setRestart(false); setPause(""); refresh(); save(); };
  const resume = () => { setAck(attention); setPause(""); };
  const status = failed ? "Send failed or unconfirmed" : delivery?.state === "sending" ? "Sending your message…"
    : conn !== "open" ? "Reconnecting — task status may be out of date"
    : task?.status === "awaiting_input" ? "Agent needs your answer" : task?.status === "awaiting_approval" ? "Agent needs approval"
    : task?.status === "running" || task?.status === "queued" ? "Agent working" : task?.status === "idle" ? "Agent is idle"
    : task?.status === "failed" ? "Task failed" : delivery?.state === "sent" ? "Message delivered" : "Ready when you are";
  return <Sheet open={open} onOpenChange={onOpenChange} autoFocus>
    <SheetContent size="panel" className="h-[900px] max-h-[calc(var(--app-height,100dvh)-8px)]" onCloseAutoFocus={onCloseAutoFocus}>
      <SheetHeader className="pb-1">
        <SheetHeaderRow><SheetTitle>Scrap Survivor</SheetTitle><Button variant="ghost" size="icon-lg" aria-label="Close game" onClick={() => onOpenChange(false)}><X /></Button></SheetHeaderRow>
        <SheetDescription className="sr-only">Move to survive. Weapons fire automatically. Collect scrap and choose upgrades.</SheetDescription>
      </SheetHeader>
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 text-sm"><p role="status" className="min-w-0 truncate">{status}</p><Button variant="outline" size="sm" onClick={() => onReturn(taskId)}><ArrowLeft data-icon="inline-start" />Back to chat</Button></div>
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-2 text-xs tabular-nums" aria-label="Expedition status">
        <span>Hull {hud.hull}/8</span><span>Lv {hud.level} · {hud.kills} cleared</span><span aria-label="Elapsed time">{Math.floor(hud.time / 60)}:{String(Math.floor(hud.time % 60)).padStart(2, "0")}{hud.boss ? " · Warden" : " / 2:30 boss"}</span>
      </div>
      <div role="progressbar" aria-label="Scrap to next level" aria-valuenow={hud.xp} aria-valuemin={0} aria-valuemax={Math.max(hud.nextXp, hud.xp)} className="mx-4 h-1 shrink-0 overflow-hidden rounded bg-muted"><div className="h-full bg-primary" style={{ width: `${Math.min(100, hud.xp / hud.nextXp * 100)}%` }} /></div>
      <div className="relative mx-3 my-2 min-h-0 flex-1 overflow-hidden rounded-xl bg-muted">
        <div ref={host} data-testid="survivor-arena" data-vaul-no-drag role="img" aria-label="Survival arena. Drag to move or use arrow keys. Weapons fire automatically." className="absolute inset-0 touch-none" />
        <MovementJoystick disabled={stopped} onMove={movePointer} />
        {(!ready || reason || restart || hud.choices.length > 0 || hud.hull <= 0 || hud.won) && <div className="absolute inset-0 flex items-center justify-center overflow-y-auto bg-background/85 p-3" data-vaul-no-drag>
          <div className="my-auto flex w-full max-w-sm flex-col gap-2 text-center">
            {error ? <><p>The game could not load.</p><Button onClick={() => setAttempt(a => a + 1)}>Retry game</Button></> : !ready ? <p role="status">Loading the scrapyard…</p>
              : restart ? <><p>Start a new expedition?</p><Button onClick={reset}>Restart</Button><Button variant="outline" onClick={() => setRestart(false)}>Keep this run</Button></>
              : reason ? <><strong>{reason}</strong>{!failed && <Button onClick={resume}>Continue playing</Button>}<Button variant="outline" onClick={() => onReturn(taskId)}>Return to conversation</Button></>
              : hud.won || hud.hull <= 0 ? <><strong>{hud.won ? "Warden defeated!" : "Hull depleted"}</strong><p>{hud.kills} enemies cleared · Level {hud.level}</p><Button onClick={reset}>New expedition</Button></>
              : <section aria-label="Choose an upgrade" className="flex flex-col gap-2"><strong>Level {hud.level} · Choose an upgrade</strong>{hud.choices.map(key => <Button variant="outline" key={key} className="h-auto min-h-16 flex-col items-start whitespace-normal p-3 text-left" onClick={() => choose(key)}><span>{UPGRADES[key].name} · Lv {hud.upgrades[key] + 1}</span><span className="text-xs text-muted-foreground">{UPGRADES[key].detail}</span></Button>)}</section>}
          </div>
        </div>}
      </div>
      {saveFailed && <Alert variant="warning" className="mx-3 w-auto shrink-0">Progress could not be saved. Keep this tab open.</Alert>}
      <div className="flex shrink-0 justify-end px-4 pb-2" data-vaul-no-drag>
        <div className="flex min-w-0 flex-row-reverse items-center gap-3"><div className="flex gap-2"><Button variant="outline" size="icon-lg" aria-label={reason ? "Resume game" : "Pause game"} disabled={!ready || failed} onClick={() => reason ? resume() : setPause("Paused")} >{reason ? <Play /> : <Pause />}</Button><Button variant="ghost" size="icon-lg" aria-label="Restart expedition" onClick={() => setRestart(true)}><RotateCcw /></Button></div><p className="text-right text-xs text-muted-foreground">{(Object.keys(UPGRADES) as Upgrade[]).filter(k => hud.upgrades[k] > 0 && UPGRADES[k].max === 5).map(k => `${k} ${hud.upgrades[k]}`).join(" · ")}</p></div>
      </div>
    </SheetContent>
  </Sheet>;
}
