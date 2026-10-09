import { useCallback, useEffect, useRef, useState } from "react";
import { chooseUpgrade, chooseReward, restoreCampaign, serializeCampaign, settleExpedition, launchExpedition, buyUpgrade, selectRobot, selectSector, selectStarter, maxHull, nearestRelay, relaysRestored, expeditionReward, type Campaign, type Point, type Upgrade, type Robot, type Sector, type Weapon, type Workshop } from "./engine";

export interface RunStorage { load(): string | null; save(value: string): void; }
export interface GameSessionOptions { active: boolean; storage: RunStorage; blockedReason?: string; newRunRequest?: string; }
const read = (storage: RunStorage) => { try { return restoreCampaign(storage.load()); } catch { return restoreCampaign(null); } };
const snapshot = (c: Campaign) => {
  const r = c.run, relay = nearestRelay(r);
  return { time: r.time, hull: r.hull, maxHull: maxHull(r), level: r.level, xp: r.xp, nextXp: r.nextXp, kills: r.kills,
    won: r.won, boss: r.boss, wardenDefeated: r.wardenDefeated, choices: [...r.choices], upgrades: { ...r.upgrades }, rewards: [...r.rewards],
    evolutions: { ...r.evolutions }, eliteWave: r.eliteWave, elitesCleared: r.elitesCleared, chestCount: r.chests.length,
    eliteActive: r.enemies.some(e => e.kind === "elite"), rig: r.rig, relays: relaysRestored(r), relayTotal: r.relays.length, retreatReward: expeditionReward(r, false),
    relay: relay ? { distance: Math.round(Math.hypot(relay.x - r.player.x, relay.y - r.player.y)), charge: relay.charge,
      angle: Math.atan2(relay.y - r.player.y, relay.x - r.player.x) } : null,
    profile: { ...c.profile, workshop: { ...c.profile.workshop }, mastery: { ...c.profile.mastery }, starters: { ...c.profile.starters } },
    hangar: c.hangar, settled: c.settled, report: c.report };
};
const directions = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] } as const;
export function useGameSession({ active, storage, blockedReason, newRunRequest }: GameSessionOptions) {
  const campaign = useRef<Campaign | null>(null);
  if (!campaign.current) { campaign.current = read(storage); settleExpedition(campaign.current); }
  const [hud, setHud] = useState(() => snapshot(campaign.current!));
  const [pause, setPause] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [ready, setReady] = useState(false), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false), [restart, setRestart] = useState(false);
  const host = useRef<HTMLDivElement>(null), keys = useRef(new Set<string>()), pointer = useRef<Point>({ x: 0, y: 0 });
  const movePointer = useCallback((point: Point) => { pointer.current = point; }, []);
  const reason = blockedReason || pause;
  const stopped = !active || !ready || Boolean(reason) || restart || inspecting || hud.hangar || hud.choices.length > 0 || hud.rewards.length > 0 || hud.hull <= 0 || hud.won;
  const stoppedRef = useRef(stopped); stoppedRef.current = stopped;
  const save = () => { try { storage.save(serializeCampaign(campaign.current!)); setSaveFailed(false); } catch { setSaveFailed(true); } };
  const refresh = () => { if (settleExpedition(campaign.current!)) save(); setHud(snapshot(campaign.current!)); };
  const clearInput = () => { keys.current.clear(); pointer.current = { x: 0, y: 0 }; };
  useEffect(() => { if (stopped) clearInput(); }, [stopped]);
  useEffect(() => {
    if (!active) return;
    if (newRunRequest && campaign.current!.settled) { campaign.current!.hangar = true; refresh(); save(); }
    setPause(document.hidden ? "Paused while away" : ""); setRestart(false); setInspecting(false);
  }, [active, newRunRequest]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false, dispose: (() => void) | undefined;
    setReady(false); setError(false);
    import("./scene").then(({ createArena }) => {
      if (cancelled || !host.current) return;
      dispose = createArena(host.current, () => campaign.current!.run, () => {
        let { x, y } = pointer.current;
        for (const key of keys.current) { const vector = directions[key as keyof typeof directions]; if (vector) { x += vector[0]; y += vector[1]; } }
        return { x, y };
      }, () => stoppedRef.current, refresh, value => { if (!cancelled) { setReady(value); setError(!value); } });
    }).catch(() => { if (!cancelled) setError(true); });
    save();
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
  const choose = (key: Upgrade) => { chooseUpgrade(campaign.current!.run, key); refresh(); save(); };
  const claim = (index: number) => { chooseReward(campaign.current!.run, index); refresh(); save(); };
  const hangar = (open: boolean) => { campaign.current!.hangar = open; setInspecting(false); refresh(); save(); };
  const retreat = () => { settleExpedition(campaign.current!, true); campaign.current!.hangar = true; setRestart(false); setPause(""); refresh(); save(); };
  const launch = () => { if (launchExpedition(campaign.current!)) { setPause(""); setInspecting(false); refresh(); save(); } };
  const purchase = (key: Workshop) => { buyUpgrade(campaign.current!.profile, key); refresh(); save(); };
  const pickRobot = (robot: Robot) => { selectRobot(campaign.current!.profile, robot); refresh(); save(); };
  const pickSector = (sector: Sector) => { selectSector(campaign.current!.profile, sector); refresh(); save(); };
  const pickStarter = (weapon: Weapon) => { selectStarter(campaign.current!.profile, weapon); refresh(); save(); };
  const resume = () => setPause("");
  return { hud, ready, error, reason, stopped, restart, saveFailed, host, movePointer, choose, claim, hangar, retreat, launch, purchase, pickRobot, pickSector, pickStarter, resume,
    setRestart, inspecting, setInspecting, togglePause: () => reason ? resume() : setPause("Paused"), retry: () => setAttempt(a => a + 1) };
}
