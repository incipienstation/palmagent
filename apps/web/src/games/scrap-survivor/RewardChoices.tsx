import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { EVOLUTIONS, UPGRADES, type Reward } from "./engine";
import { ChestArt, EquipmentArt } from "./art";

export function RewardChoices({ rewards, onChoose }: { rewards: Reward[]; onChoose: (index: number) => void }) {
  return <section aria-label="Choose an elite reward" className="flex flex-col gap-2">
    <div className="survivor-panel-art"><ChestArt /></div>
    <div className="survivor-upgrade-heading"><p className="survivor-eyebrow">ELITE SALVAGE</p><h2>Claim your reward</h2><p className="survivor-caption">Choose one. Your expedition is paused.</p></div>
    {rewards.map((reward, index) => {
      const key = reward.kind === "evolve" ? reward.weapon : reward.kind === "upgrade" ? reward.upgrade : null;
      const name = reward.kind === "evolve" ? EVOLUTIONS[reward.weapon].name : reward.kind === "upgrade" ? UPGRADES[reward.upgrade].name : "Full hull repair";
      const detail = reward.kind === "evolve" ? EVOLUTIONS[reward.weapon].detail : reward.kind === "upgrade" ? "Gain one level and repair hull." : "Restore your robot to full HP.";
      return <Button key={index} variant="outline" className="survivor-upgrade h-auto min-h-24 justify-start gap-2 whitespace-normal p-2 text-left" onClick={() => onChoose(index)}>
        <span className="survivor-item-frame">{key ? <EquipmentArt kind={key} evolved={reward.kind === "evolve"} /> : <ChestArt />}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-1"><Badge variant={reward.kind === "evolve" ? "default" : "secondary"}>{reward.kind === "evolve" ? "EVOLUTION" : "SUPPLY"}</Badge><span>{name}</span><span className="survivor-caption">{detail}</span></span>
      </Button>;
    })}
    {!rewards.some(r => r.kind === "evolve") && <p className="survivor-caption">For an evolution, reach weapon Lv 5 and equip its matching support before opening a chest.</p>}
  </section>;
}
