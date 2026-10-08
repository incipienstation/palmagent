import equipment from "./assets/equipment-v2.webp?url";
import units from "./assets/units.webp?url";
import type { Upgrade } from "./engine";

// Normalized source rectangles preserve the generated silhouettes and their aspect ratios.
export const unitFrames = [
  [0.065, 0.12, 0.22, 0.27], [0.395, 0.12, 0.205, 0.285], [0.725, 0.12, 0.205, 0.285],
  [0.025, 0.63, 0.29, 0.235], [0.365, 0.56, 0.245, 0.305], [0.635, 0.54, 0.36, 0.34],
] as const;
const equipmentFrames: Record<Upgrade, readonly number[]> = {
  bolt: [0.09, 0.31, 0.20, 0.19], blade: [0.405, 0.295, 0.195, 0.195], arc: [0.73, 0.27, 0.185, 0.225],
  reactor: [0.085, 0.705, 0.195, 0.21], magnet: [0.405, 0.705, 0.20, 0.22], boots: [0.715, 0.725, 0.24, 0.20],
};
function AtlasArt({ src, frame }: { src: string; frame: readonly number[] }) {
  return <svg aria-hidden="true" className="survivor-art" viewBox={frame.join(" ")}><image href={src} width="1" height="1" /></svg>;
}
export function EquipmentArt({ kind }: { kind: Upgrade }) { return <AtlasArt src={equipment} frame={equipmentFrames[kind]} />; }
export function RobotArt({ boss = false }: { boss?: boolean }) { return <AtlasArt src={units} frame={unitFrames[boss ? 5 : 0]} />; }
