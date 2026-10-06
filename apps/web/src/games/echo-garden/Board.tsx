import { useId } from "react";
import { CircleDot, Flower2, Sprout } from "lucide-react";
import { Button } from "../../components/ui/button";
import { PHASE_NAMES, plantName, type Garden, type Level } from "./engine";

const icons = [CircleDot, Sprout, Flower2];

export function Board({ level, garden, solved, onMove }: {
  level: Level; garden: Garden; solved: boolean; onMove: (plant: number) => void;
}) {
  const id = useId();
  const points = garden.plants.map((_, index) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / garden.plants.length;
    return { x: 180 + 120 * Math.cos(angle), y: 155 + 110 * Math.sin(angle) };
  });
  return <div role="group" aria-label="Garden plants" className="relative mx-auto aspect-[6/5] w-full max-w-[400px]" data-vaul-no-drag>
    <svg viewBox="0 0 360 300" className="pointer-events-none absolute inset-0 size-full text-muted-foreground" aria-hidden="true">
      <defs><marker id={`${id}-arrow`} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="currentColor" /></marker></defs>
      {level.links.map(([from, to, delay]) => {
        const a = points[from], b = points[to];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length;
        const start = { x: a.x + ux * 43, y: a.y + uy * 43 };
        const end = { x: b.x - ux * 43, y: b.y - uy * 43 };
        const mid = { x: (a.x + b.x) / 2 - uy * 12, y: (a.y + b.y) / 2 + ux * 12 };
        return <g key={`${from}-${to}`}>
          <path d={`M${start.x},${start.y} Q${mid.x},${mid.y} ${end.x},${end.y}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={delay === 2 ? "4 4" : undefined} markerEnd={`url(#${id}-arrow)`} />
          <circle cx={mid.x} cy={mid.y} r="10" className="fill-card" />
          <text x={mid.x} y={mid.y + 4} textAnchor="middle" fill="currentColor" fontSize="12">{delay}</text>
        </g>;
      })}
    </svg>
    {garden.plants.map((phase, index) => {
      const Icon = icons[phase];
      const routes = level.links.filter(([from]) => from === index).map(([, to, delay]) => `${plantName(to)} in ${delay} ${delay === 1 ? "turn" : "turns"}`);
      const arrivals = garden.echoes.filter(echo => echo.plant === index);
      const description = `${routes.length ? `Tapping into bloom sends echoes to ${routes.join(" and ")}.` : "No outgoing echoes."} ${arrivals.map(echo => `Incoming growth in ${echo.turns} ${echo.turns === 1 ? "turn" : "turns"}.`).join(" ")}`;
      return <div key={index} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${points[index].x / 3.6}%`, top: `${points[index].y / 3}%` }}>
        <Button type="button" variant={phase === 2 ? "selected" : "secondary"} className="size-16 flex-col gap-0.5 rounded-2xl p-1" aria-label={`Plant ${plantName(index)}: ${PHASE_NAMES[phase]}`} aria-describedby={`${id}-plant-${index}`} aria-disabled={solved} onClick={() => { if (!solved) onMove(index); }}>
          <Icon aria-hidden="true" />
          <span className="text-xs">{plantName(index)} · {PHASE_NAMES[phase]}</span>
        </Button>
        <span id={`${id}-plant-${index}`} className="sr-only">{description}</span>
      </div>;
    })}
  </div>;
}
