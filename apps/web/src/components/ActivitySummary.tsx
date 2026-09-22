import { ChevronRight, FilePenLine, FileSearch, Terminal, Wrench } from "lucide-react";
import { activityLabel, failed, payload, type Activity } from "../transcript";
import type { OutputMode } from "../OutputModeProvider";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { WorkingLabel } from "./WorkingLabel";
import { cn } from "../lib/utils";

// Compact tool chips and expandable progress, inspired by Beautiful UI:
// https://www.beautifului.dev/ — render only real events, with no timed reveals.
export function ActivitySummary({ activity, mode, open, onToggle }: {
  activity: Activity; mode: OutputMode; open: boolean; onToggle: () => void;
}) {
  const tools = new Map<string | number, { name: string; detail: string; failed: boolean }>();
  const errors = new Set<string | number>();
  for (const item of activity.items) {
    const p = payload(item);
    const id = typeof p.id === "string" ? p.id : item.key;
    if (failed(item)) errors.add(typeof p.tool_use_id === "string" ? p.tool_use_id : id);
    if (item.kind !== "tool_call") continue;
    const input = p.input && typeof p.input === "object" ? p.input as Record<string, unknown> : {};
    const target = input.file_path ?? input.path ?? input.command ?? p.command;
    const detail = typeof target === "string" ? target : Array.isArray(target) ? target.join(" ") : "";
    tools.set(id, { name: typeof p.name === "string" ? p.name : "Tool", detail, failed: false });
  }
  for (const [id, tool] of tools) tool.failed = errors.has(id);
  const chips = [...tools.values()];
  const label = activityLabel(activity, mode);
  return <div data-activity className={cn("min-w-0 font-sans text-muted-foreground", !open && "mb-3")}>
    <Button variant="ghost" className={cn("h-auto min-h-11 flex-col items-stretch gap-2 text-left", activity.live ? "px-0 py-2" : "w-full rounded-xl border border-border px-3 py-2.5")}
      aria-label={label} title={label} aria-expanded={open} onClick={onToggle}>
      <span className="flex min-w-0 items-center gap-2">
        {activity.live ? <WorkingLabel /> : <>
          <Wrench data-icon="inline-start" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </>}
        {(!activity.live || open) && <ChevronRight data-icon="inline-end" className={cn("transition-transform motion-reduce:transition-none", open && "rotate-90")} />}
      </span>
      {(!activity.live || open) && mode !== "compact" && chips.length > 0 && <span className="flex flex-wrap gap-1.5" aria-hidden>
        {chips.slice(0, 3).map((tool, index) => {
          const Icon = /bash|command_execution/i.test(tool.name) ? Terminal : /write|edit|file_change/i.test(tool.name) ? FilePenLine : /read|glob|grep/i.test(tool.name) ? FileSearch : Wrench;
          return <Badge key={index} variant={tool.failed ? "destructive" : "secondary"} className="max-w-full gap-1.5" title={`${tool.name} ${tool.detail}`}>
            <Icon /><span className="truncate">{tool.name}{tool.detail ? ` · ${(/read|write|edit/i.test(tool.name) ? tool.detail.split("/").at(-1) : tool.detail)}` : ""}</span>
          </Badge>;
        })}
        {chips.length > 3 && <Badge variant="outline">+{chips.length - 3}</Badge>}
      </span>}
    </Button>
    {activity.live && open && <p className="mb-2 text-xs">{label}</p>}
    {!open && activity.preview && <div data-progress-preview className={cn("mt-2 border-l-2 border-border pl-3 text-[13px] break-words [overflow-wrap:anywhere]", mode === "compact" ? "line-clamp-1" : "line-clamp-2")}>{activity.preview}</div>}
  </div>;
}
