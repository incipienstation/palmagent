import { Pause, Play, RotateCcw, Shield, Crosshair, Clock3 } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Alert } from "../../components/ui/alert";
import { BOSS_TIME, ELITE_TIMES, EVOLUTIONS, EVOLUTION_KEYS, UPGRADE_KEYS, UPGRADES, WEAPON_SLOTS, isWeapon, weaponCount, upgradeGain, evolutionHint, type Upgrade, type EvolvingWeapon } from "./engine";
import { EquipmentArt, RobotArt } from "./art";
import { MovementJoystick } from "./MovementJoystick";
import { RewardChoices } from "./RewardChoices";
import { useGameSession, type GameSessionOptions } from "./useGameSession";

export function SurvivorGame({ onExit, ...options }: GameSessionOptions & { onExit: () => void }) {
  const { blockedReason } = options;
  const { hud, ready, error, reason, stopped, restart, saveFailed, host, movePointer, choose, claim, reset, resume,
    setRestart, inspecting, setInspecting, togglePause, retry } = useGameSession(options);
  const isEvolved = (key: Upgrade) => EVOLUTION_KEYS.includes(key as EvolvingWeapon) && hud.evolutions[key as EvolvingWeapon];
  const equipmentName = (key: Upgrade) => isEvolved(key) ? EVOLUTIONS[key as EvolvingWeapon].name : UPGRADES[key].name;
  return <>
      <div className="survivor-hud" aria-label="Expedition status">
        <div className="survivor-health" data-critical={hud.hull <= 2}>
          <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1"><Shield size={13} aria-hidden="true" />HP</span><strong>{hud.hull}/8</strong></div>
          <div className="survivor-health-cells" role="meter" aria-label="Player HP" aria-valuenow={hud.hull} aria-valuemin={0} aria-valuemax={8}>
            {Array.from({ length: 8 }, (_, i) => <span key={i} data-filled={i < hud.hull} />)}
          </div>
        </div>
        <div className="survivor-stat"><span><Crosshair size={13} aria-hidden="true" />CLEARED</span><strong>{hud.kills}</strong></div>
        <div className="survivor-stat"><span><Clock3 size={13} aria-hidden="true" />{hud.boss ? "WARDEN" : "BOSS IN"}</span><strong aria-label={hud.boss ? "Elapsed time" : "Time until Warden"}>{hud.boss ? `${Math.floor(hud.time / 60)}:${String(Math.floor(hud.time % 60)).padStart(2, "0")}` : `${Math.floor(Math.ceil(Math.max(0, BOSS_TIME - hud.time)) / 60)}:${String(Math.ceil(Math.max(0, BOSS_TIME - hud.time)) % 60).padStart(2, "0")}`}</strong></div>
      </div>
      <div className="survivor-xp-row"><strong>LV {hud.level}</strong><div role="progressbar" aria-label="Scrap to next level" aria-valuenow={hud.xp} aria-valuemin={0} aria-valuemax={Math.max(hud.nextXp, hud.xp)} className="survivor-xp"><div style={{ width: `${Math.min(100, hud.xp / hud.nextXp * 100)}%` }} /></div><span>{hud.xp}/{hud.nextXp}</span></div>
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 text-xs" aria-label="Loadout and encounter">
        <span>{weaponCount(hud)}/{WEAPON_SLOTS} weapons</span><span>{hud.chestCount ? "Elite chest available" : hud.eliteActive ? "Elite sentinel active" : hud.eliteWave < ELITE_TIMES.length ? `Elite in ${Math.ceil(Math.max(0, ELITE_TIMES[hud.eliteWave] - hud.time))}s` : `Elites: ${hud.elitesCleared}/2 cleared`}</span>
      </div>
      <div className="survivor-board relative mx-3 my-2 min-h-0 flex-1 overflow-hidden rounded-xl">
        <div ref={host} data-testid="survivor-arena" data-vaul-no-drag role="img" aria-label="Survival arena. Drag in the lower control area or use arrow keys. Weapons fire automatically." className="absolute inset-0 touch-none" />
        <MovementJoystick disabled={stopped} onMove={movePointer} />
        {(!ready || reason || restart || inspecting || hud.choices.length > 0 || hud.rewards.length > 0 || hud.hull <= 0 || hud.won) && <div className="survivor-overlay absolute inset-0 flex overflow-y-auto p-3" data-vaul-no-drag>
          <div className="my-auto flex w-full flex-col gap-3 text-center">
            {error ? <><div className="survivor-panel-art"><RobotArt /></div><strong>The game could not load.</strong><Button onClick={retry}>Retry game</Button></> : !ready ? <><div className="survivor-panel-art"><RobotArt /></div><p role="status">Loading the scrapyard…</p></>
              : restart ? <><div className="survivor-panel-art"><RobotArt /></div><p className="survivor-eyebrow">NEW RUN</p><strong>Start a new expedition?</strong><p className="survivor-caption">Your current loadout and progress will be replaced.</p><Button onClick={reset}>Restart</Button><Button variant="outline" onClick={() => setRestart(false)}>Keep this run</Button></>
              : reason ? <><div className="survivor-panel-art"><RobotArt /></div><p className="survivor-eyebrow">EXPEDITION ON HOLD</p><strong>{reason}</strong>{!blockedReason && <Button onClick={resume}><Play data-icon="inline-start" />Continue playing</Button>}<Button variant="outline" onClick={onExit}>Exit game</Button></>
              : inspecting ? <section aria-label="Loadout details" className="flex flex-col gap-3 text-left"><h2 className="text-center font-bold">Your loadout · {weaponCount(hud)}/{WEAPON_SLOTS} weapons</h2>
                {UPGRADE_KEYS.filter(k => hud.upgrades[k] > 0).map(key => <div key={key} className="flex items-center gap-2"><span className="survivor-item-frame"><EquipmentArt kind={key} evolved={isEvolved(key)} /></span><div className="min-w-0"><strong>{equipmentName(key)} · Lv {hud.upgrades[key]}</strong><p className="survivor-caption">{isEvolved(key) ? EVOLUTIONS[key as EvolvingWeapon].detail : UPGRADES[key].detail}</p>{evolutionHint(key, hud) && <p className="survivor-caption">{evolutionHint(key, hud)}</p>}</div></div>)}
                <Button onClick={() => setInspecting(false)}>Close loadout</Button>
              </section>
              : hud.won || hud.hull <= 0 ? <><div className="survivor-panel-art"><RobotArt boss={!hud.won} /></div><p className="survivor-eyebrow">{hud.won ? "MISSION COMPLETE" : "SIGNAL LOST"}</p><strong className="survivor-result-title">{hud.won ? "Warden defeated!" : "Hull depleted"}</strong><p>{hud.kills} enemies cleared · Level {hud.level}</p><div className="survivor-result-loadout">{UPGRADE_KEYS.filter(k => hud.upgrades[k] > 0).map(k => <span key={k} title={`${equipmentName(k)} level ${hud.upgrades[k]}`}><EquipmentArt kind={k} evolved={isEvolved(k)} /><small>{isEvolved(k) ? "★" : hud.upgrades[k]}</small></span>)}</div><Button onClick={reset}>New expedition</Button></>
              : hud.rewards.length ? <RewardChoices rewards={hud.rewards} onChoose={claim} />
              : <section aria-label="Choose an upgrade" className="flex flex-col gap-2">
                <div className="survivor-upgrade-heading"><p className="survivor-eyebrow">LEVEL {hud.level} / UPGRADE READY</p><h2>Build your loadout</h2><p className="survivor-caption">{weaponCount(hud)}/{WEAPON_SLOTS} weapons equipped. Supports use no weapon slots.</p></div>
                {hud.choices.map(key => <Button variant="outline" key={key} className="survivor-upgrade h-auto min-h-24 justify-start gap-2 whitespace-normal p-2 text-left" onClick={() => choose(key)}>
                  <span className="survivor-item-frame"><EquipmentArt kind={key} /></span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1"><span className="survivor-item-meta">{hud.upgrades[key] === 0 ? isWeapon(key) ? "NEW WEAPON / USES A SLOT" : "NEW SUPPORT" : `LV ${hud.upgrades[key]} → ${hud.upgrades[key] + 1}`}</span><span>{UPGRADES[key].name}</span><span className="survivor-caption">{upgradeGain(key, hud.upgrades[key])}</span><span className="survivor-caption">{evolutionHint(key, hud)}</span><span className="survivor-level-pips" aria-hidden="true">{Array.from({ length: UPGRADES[key].max }, (_, i) => <i key={i} data-filled={i < hud.upgrades[key]} data-next={i === hud.upgrades[key]} />)}</span></span>
                </Button>)}
              </section>}
          </div>
        </div>}
      </div>
      {saveFailed && <Alert variant="warning" className="mx-3 w-auto shrink-0">Progress could not be saved. Keep this tab open.</Alert>}
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-2" data-vaul-no-drag>
        <button type="button" className="min-w-0 rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring" aria-label="Inspect loadout" onClick={() => setInspecting(true)}><span className="survivor-loadout" aria-label="Equipped upgrades">{UPGRADE_KEYS.filter(k => hud.upgrades[k] > 0).map(k => <span key={k} role="img" aria-label={`${equipmentName(k)} level ${hud.upgrades[k]}`} title={`${equipmentName(k)} level ${hud.upgrades[k]}`}><EquipmentArt kind={k} evolved={isEvolved(k)} /><small>{isEvolved(k) ? "★" : hud.upgrades[k]}</small></span>)}</span></button>
        <div className="flex shrink-0 gap-1"><Button variant="outline" size="icon-lg" aria-label={reason ? "Resume game" : "Pause game"} disabled={!ready || Boolean(blockedReason)} onClick={togglePause} >{reason ? <Play /> : <Pause />}</Button><Button variant="ghost" size="icon-lg" aria-label="Restart expedition" onClick={() => setRestart(true)}><RotateCcw /></Button></div>
      </div>
  </>;
}
