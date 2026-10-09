import equipment from "./assets/equipment-v2.webp?url";
import units from "./assets/units.webp?url";
import { EVOLUTION_KEYS, type Upgrade, type EvolvingWeapon, type Robot } from "./engine";
import { unitFrames, expansionFrames, expansionTexture, robotFrames, robotTexture, finalWeaponFrames, finalWeaponTexture } from "./atlas";

const equipmentFrames: Record<Exclude<Upgrade, "mine" | "drone">, readonly number[]> = {
  bolt: [0.09, 0.31, 0.20, 0.19], blade: [0.405, 0.295, 0.195, 0.195], arc: [0.73, 0.27, 0.185, 0.225],
  reactor: [0.085, 0.705, 0.195, 0.21], magnet: [0.405, 0.705, 0.20, 0.22], boots: [0.715, 0.725, 0.24, 0.20],
};
function AtlasArt({ src, frame }: { src: string; frame: readonly number[] }) {
  const width = src === expansionTexture.url ? 1536 : 1, height = src === expansionTexture.url ? 1024 : 1;
  const [x, y, w, h] = frame;
  return <svg aria-hidden="true" className="survivor-art" viewBox={[x * width, y * height, w * width, h * height].join(" ")}><image href={src} width={width} height={height} /></svg>;
}
export function EquipmentArt({ kind, evolved = false }: { kind: Upgrade; evolved?: boolean }) {
  if (evolved && EVOLUTION_KEYS.includes(kind as EvolvingWeapon)) {
    return <AtlasArt src={finalWeaponTexture.url} frame={finalWeaponFrames[kind as EvolvingWeapon]} />;
  }
  if (kind === "mine" || kind === "drone") {
    return <AtlasArt src={expansionTexture.url} frame={expansionFrames[kind as keyof typeof expansionFrames]} />;
  }
  return <AtlasArt src={equipment} frame={equipmentFrames[kind as keyof typeof equipmentFrames]} />;
}
export function ChestArt() { return <AtlasArt src={expansionTexture.url} frame={expansionFrames.chest} />; }
export function RobotArt({ boss = false, robot = "scout" }: { boss?: boolean; robot?: Robot }) {
  return !boss && robot !== "scout" ? <AtlasArt src={robotTexture.url} frame={robotFrames[robot === "bulwark" ? 0 : 3]} /> : <AtlasArt src={units} frame={unitFrames[boss ? 5 : 0]} />;
}
