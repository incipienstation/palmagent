import { useEffect, useRef } from "react";
import { Lock, Rocket, Wrench } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { ROBOTS, ROBOT_KEYS, SECTORS, SECTOR_KEYS, UPGRADES, WORKSHOP, WORKSHOP_CAP, WORKSHOP_KEYS, masteryRank,
  robotUnlocked, starterOptions, workshopCost, type Debrief, type Profile, type Robot, type Sector, type Weapon, type Workshop } from "./engine";
import { EquipmentArt, RobotArt } from "./art";

export function ExpeditionDebrief({ report }: { report: Debrief }) {
  return <section aria-label="Expedition rewards" className="flex flex-col gap-2">
    <div className="flex flex-wrap justify-center gap-2"><Badge>+{report.parts} parts</Badge><Badge variant="secondary">+{report.mastery} mastery</Badge></div>
    <p className="survivor-caption">{report.outcome === "victory" ? "Salvage secured. Workshop upgrades carry into future expeditions."
      : "Half of earned salvage recovered. Mastery retained."}</p>
    {report.unlocks.length > 0 && <ul className="flex flex-col gap-1 text-sm" aria-label="New unlocks">{report.unlocks.map(unlock => <li key={unlock}>{unlock}</li>)}</ul>}
  </section>;
}

export function Hangar({ profile, settled, report, onResume, onRetreat, onLaunch, onPurchase, onRobot, onSector, onStarter }: {
  profile: Profile; settled: boolean; report: Debrief | null;
  onResume: () => void; onRetreat: () => void; onLaunch: () => void; onPurchase: (key: Workshop) => void;
  onRobot: (robot: Robot) => void; onSector: (sector: Sector) => void; onStarter: (weapon: Weapon) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  const robot = ROBOTS[profile.robot], points = profile.mastery[profile.robot], rank = masteryRank(points);
  const starters = starterOptions(profile, profile.robot);
  return <section aria-label="Hangar" className="flex flex-col gap-5 text-left">
    <header className="flex items-center justify-between gap-3"><div><p className="survivor-eyebrow">SCRAP SURVIVOR</p><h2 ref={heading} tabIndex={-1} className="text-xl font-bold outline-none">Hangar</h2></div><Badge variant="outline">{profile.parts} parts</Badge></header>
    {report && <ExpeditionDebrief report={report} />}
    <section aria-label="Robot selection" className="flex flex-col gap-2">
      <h3 className="font-semibold">Choose your robot</h3>
      <ToggleGroup type="single" value={profile.robot} onValueChange={value => { if (value) onRobot(value as Robot); }} aria-label="Robot class">
        {ROBOT_KEYS.map(key => <ToggleGroupItem key={key} value={key} disabled={!robotUnlocked(profile, key)} className="h-auto flex-col gap-1 py-2" aria-label={ROBOTS[key].name}>
          <span className="size-16"><RobotArt robot={key} /></span><span className="flex items-center gap-1">{!robotUnlocked(profile, key) && <Lock className="size-3" aria-hidden="true" />}{ROBOTS[key].name}</span>
        </ToggleGroupItem>)}
      </ToggleGroup>
      <p className="text-sm">{robot.trait}</p>
      {ROBOT_KEYS.filter(key => !robotUnlocked(profile, key)).map(key => <p key={key} className="survivor-caption">{ROBOTS[key].name}: recover {ROBOTS[key].unlock} total parts to unlock ({profile.earned}/{ROBOTS[key].unlock}). Spending parts does not reduce progress.</p>)}
      <div className="flex items-center justify-between gap-2"><span className="text-sm">{robot.name} mastery</span><Badge variant="secondary">{points}{rank < 2 ? ` / ${rank === 0 ? 30 : 90}` : " · MAX"}</Badge></div>
      <div role="progressbar" aria-label={`${robot.name} mastery`} aria-valuenow={Math.min(points, 90)} aria-valuemin={0} aria-valuemax={90} className="survivor-xp" style={{ flex: "none" }}><div style={{ width: `${Math.min(100, points / 90 * 100)}%` }} /></div>
      <p className="survivor-caption">{rank < 1 ? `30 mastery: unlock ${UPGRADES[robot.alternate].name} as a starting weapon. ` : "Alternate starting weapon unlocked. "}{rank < 2 ? "90 mastery: " : "Mastered: "}{robot.mastery}</p>
      <h4 className="text-sm font-medium">Starting weapon</h4>
      <ToggleGroup type="single" value={profile.starters[profile.robot]} onValueChange={value => { if (value) onStarter(value as Weapon); }} aria-label="Starting weapon">
        {starters.map(key => <ToggleGroupItem key={key} value={key} className="h-auto gap-2 py-2" aria-label={UPGRADES[key].name}><span className="size-8"><EquipmentArt kind={key} /></span><span>{UPGRADES[key].name}</span></ToggleGroupItem>)}
      </ToggleGroup>
    </section>
    <section aria-label="Sector selection" className="flex flex-col gap-2">
      <h3 className="font-semibold">Expedition sector</h3>
      <ToggleGroup type="single" value={String(profile.sector)} onValueChange={value => { if (value) onSector(Number(value) as Sector); }} aria-label="Expedition sector">
        {SECTOR_KEYS.map(sector => <ToggleGroupItem key={sector} value={String(sector)} disabled={sector > profile.unlockedSector} className="h-auto flex-col gap-1 py-2" aria-label={`Sector ${sector}: ${SECTORS[sector].name}`}>
          <span className="flex items-center gap-1">{sector > profile.unlockedSector && <Lock className="size-3" aria-hidden="true" />}Sector {sector}</span><span>{SECTORS[sector].name}</span>
        </ToggleGroupItem>)}
      </ToggleGroup>
      <p className="text-sm">{SECTORS[profile.sector].detail}</p>
      <p className="survivor-caption">{profile.unlockedSector < 3 ? "Clear the highest available sector to unlock the next. Earlier sectors remain replayable." : "All sectors unlocked. Replay any sector to master other robots and finish your workshop."}</p>
    </section>
    <section aria-label="Workshop" className="flex flex-col gap-3">
      <div><h3 className="flex items-center gap-2 font-semibold"><Wrench className="size-4" aria-hidden="true" />Workshop</h3><p className="survivor-caption">Permanent upgrades · apply on your next launch</p></div>
      {WORKSHOP_KEYS.map(key => {
        const level = profile.workshop[key], maxed = level >= WORKSHOP_CAP, cost = workshopCost(level);
        return <div key={key} className="flex items-center justify-between gap-2"><div className="min-w-0"><p className="text-sm font-medium">{WORKSHOP[key].name} · {level}/{WORKSHOP_CAP}</p><p className="survivor-caption">{WORKSHOP[key].detail}</p></div><Button variant="outline" size="sm" disabled={maxed || profile.parts < cost} aria-label={`Upgrade ${WORKSHOP[key].name}`} onClick={() => onPurchase(key)}>{maxed ? "Maxed" : `${cost} parts`}</Button></div>;
      })}
    </section>
    <div className="flex flex-col gap-2">
      {settled ? <Button onClick={onLaunch}><Rocket data-icon="inline-start" />Launch expedition</Button> : <><Button onClick={onResume}>Resume expedition</Button><Button variant="outline" onClick={onRetreat}>End current expedition</Button></>}
      <p className="survivor-caption text-center">{!settled && "Your expedition is paused. "}Progress is saved in this browser.</p>
    </div>
  </section>;
}
