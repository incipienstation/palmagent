import { useCallback, useEffect, useRef, useState } from "react";
import { chooseUpgrade, chooseReward, freshRun, restore, serialize, type Point, type Run, type Upgrade } from "./engine";

export interface RunStorage { load(): string | null; save(value: string): void; }
export interface GameSessionOptions { active: boolean; storage: RunStorage; blockedReason?: string; newRunRequest?: string; }
const read = (storage: RunStorage) => { try { return restore(storage.load()); } catch { return freshRun(); } };
const snapshot = (r: Run) => ({ time: r.time, hull: r.hull, level: r.level, xp: r.xp, nextXp: r.nextXp, kills: r.kills,
  won: r.won, boss: r.boss, choices: [...r.choices], upgrades: { ...r.upgrades }, rewards: [...r.rewards],
  evolutions: { ...r.evolutions }, eliteWave: r.eliteWave, elitesCleared: r.elitesCleared, chestCount: r.chests.length, eliteActive: r.enemies.some(e => e.kind === "elite") });
const directions = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] } as const;
export function useGameSession({ active, storage, blockedReason, newRunRequest }: GameSessionOptions) {
  const run = useRef<Run | null>(null); if (!run.current) run.current = read(storage);
  const [hud, setHud] = useState(() => snapshot(run.current!));
  const [pause, setPause] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [ready, setReady] = useState(false), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false), [restart, setRestart] = useState(false);
  const host = useRef<HTMLDivElement>(null), keys = useRef(new Set<string>()), pointer = useRef<Point>({ x: 0, y: 0 });
  const movePointer = useCallback((point: Point) => { pointer.current = point; }, []);
  const reason = blockedReason || pause;
  const stopped = !active || !ready || Boolean(reason) || restart || inspecting || hud.choices.length > 0 || hud.rewards.length > 0 || hud.hull <= 0 || hud.won;
  const stoppedRef = useRef(stopped); stoppedRef.current = stopped;
  const refresh = () => setHud(snapshot(run.current!));
  const save = () => { try { storage.save(serialize(run.current!)); setSaveFailed(false); } catch { setSaveFailed(true); } };
  const clearInput = () => { keys.current.clear(); pointer.current = { x: 0, y: 0 }; };
  useEffect(() => { if (stopped) clearInput(); }, [stopped]);
  useEffect(() => {
    if (!active) return;
    if (newRunRequest && (run.current!.won || run.current!.hull <= 0)) { run.current = freshRun(); refresh(); }
    setPause(document.hidden ? "Paused while away" : ""); setRestart(false); setInspecting(false);
  }, [active, newRunRequest]);
  useEffect(() => {
    if (!active) return;
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
  }, [active, attempt, storage]);
  const choose = (key: Upgrade) => { chooseUpgrade(run.current!, key); refresh(); save(); };
  const claim = (index: number) => { chooseReward(run.current!, index); refresh(); save(); };
  const reset = () => { run.current = freshRun(); setRestart(false); setInspecting(false); setPause(""); refresh(); save(); };
  const resume = () => setPause("");
  return { hud, ready, error, reason, stopped, restart, saveFailed, host, movePointer, choose, claim, reset, resume,
    setRestart, inspecting, setInspecting, togglePause: () => reason ? resume() : setPause("Paused"), retry: () => setAttempt(a => a + 1) };
}
