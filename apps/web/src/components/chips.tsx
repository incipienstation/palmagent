import type { AgentKind, Repo, TaskStatus } from "@palmagent/shared";
import { Folder, FolderGit2, GitBranch } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { statusLabel } from "@/lib/status";
import { cn } from "@/lib/utils";

// The ONLY place agent kind is allowed to affect the UI: a label + color. Above
// this, everything renders the normalized AgentEvent without caring who emitted it.
const AGENT_COLOR: Record<AgentKind, string> = {
  claude: "text-purple",
  codex: "text-green",
};

export function AgentTag({ agent }: { agent: AgentKind }) {
  return (
    <Badge variant="outline" className={cn("font-semibold", AGENT_COLOR[agent])}>
      {agent}
    </Badge>
  );
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
    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground">
      <Icon aria-hidden className="size-3.5 shrink-0 text-faint" />
      <span className="truncate">{repo.name}</span>
      {isolated && (
        <GitBranch aria-hidden className="size-3 shrink-0 text-faint" aria-label="isolated worktree" />
      )}
    </span>
  );
}

// Per-status tinted pill. Every color comes from the dual-theme --status-* tokens
// (no inline hex) so badges read correctly in both light and dark. awaiting_* maps
// to the approval/input token families.
const STATUS_STYLE: Record<TaskStatus, string> = {
  queued: "bg-status-queued-bg text-status-queued-fg",
  running: "bg-status-running-bg text-status-running-fg",
  awaiting_approval: "bg-status-approval-bg text-status-approval-fg",
  awaiting_input: "bg-status-input-bg text-status-input-fg",
  idle: "bg-status-idle-bg text-status-idle-fg",
  failed: "bg-status-failed-bg text-status-failed-fg",
  cancelled: "bg-status-cancelled-bg text-status-cancelled-fg",
  archived: "bg-status-archived-bg text-status-archived-fg",
};

export function StatusBadge({ status, interrupted }: { status: TaskStatus; interrupted?: boolean }) {
  return (
    <Badge className={cn("px-2 py-0.5 font-medium", STATUS_STYLE[status])}>
      {statusLabel(status, interrupted)}
    </Badge>
  );
}
