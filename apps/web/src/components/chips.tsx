import type { AgentKind, Repo, SessionControl, TaskStatus } from "@palmagent/shared";
import { Folder, FolderGit2, GitBranch } from "lucide-react";

import { statusLabel } from "@/lib/status";
import { cn } from "@/lib/utils";

// Agent identity is secondary context, independent of task status.
export function AgentTag({ agent }: { agent: AgentKind }) {
  return <span className="text-xs font-normal text-muted-foreground">{agent}</span>;
}

// The project (repo) a task belongs to — the card's "where am I" anchor, sat as
// an eyebrow above the title so a mixed-project inbox is scannable by project at
// a glance. The folder icon doubles as the vcs hint (git vs plain folder); an
// isolated git task (its own worktree+branch) gets a small branch glyph instead
// of dumping the raw `agent/<taskId>` branch into the meta line. Renders nothing
// when the repo isn't known yet (the lookup self-heals on the next fetch).
export function RepoChip({ repo, isolated }: { repo?: Repo; isolated?: boolean }) {
  if (!repo) return null;
  const Icon = repo.vcs === "git" ? FolderGit2 : Folder;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground">
      <Icon aria-hidden className="size-3.5 shrink-0 text-faint" />
      <span className="truncate">{repo.name}</span>
      {isolated && (
        <GitBranch aria-hidden className="size-3 shrink-0 text-faint" aria-label="isolated worktree" />
      )}
    </span>
  );
}

// Color is limited to a small indicator; the text always communicates state.
const STATUS_STYLE: Record<TaskStatus, string> = {
  queued: "bg-amber",
  running: "bg-live",
  awaiting_approval: "bg-amber",
  awaiting_input: "bg-amber",
  idle: "bg-muted-foreground",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground",
  archived: "bg-faint",
};

export function StatusBadge({ status, interrupted, sessionControl }: { status: TaskStatus; interrupted?: boolean; sessionControl?: SessionControl }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-normal text-muted-foreground">
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", STATUS_STYLE[status])} />
      {statusLabel(status, interrupted, sessionControl)}
    </span>
  );
}
