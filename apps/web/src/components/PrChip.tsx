import type { PrRef } from "@palmagent/shared";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

// Per-PR status → dot color + label + an "urgency" rank. Color comes from the
// dual-theme semantic tokens (no inline hex). Urgency picks which PR colors the
// collapsed chip when a task opened several: the one most needing attention wins
// (failed > checks-running > ready > open > merged > draft/closed) — mirrors the
// Claude Code agent-view "colored by the open PR that most needs attention".
interface PrTone {
  dot: string;
  text: string;
  label: string;
  urgency: number;
}
function prTone(pr: PrRef): PrTone {
  if (pr.status === "merged") return { dot: "bg-purple", text: "text-purple", label: "merged", urgency: 1 };
  if (pr.status === "closed") return { dot: "bg-faint", text: "text-faint", label: "closed", urgency: 0 };
  if (pr.status === "draft") return { dot: "bg-faint", text: "text-faint", label: "draft", urgency: 0 };
  // open — color by the CI check rollup.
  switch (pr.checks) {
    case "failed":
      return { dot: "bg-destructive", text: "text-destructive", label: "checks failed", urgency: 5 };
    case "pending":
      return { dot: "bg-amber", text: "text-amber", label: "checks running", urgency: 4 };
    case "passed":
      return { dot: "bg-green", text: "text-green", label: "ready to merge", urgency: 3 };
    default:
      return { dot: "bg-blue", text: "text-blue", label: "open", urgency: 2 };
  }
}
const topTone = (prs: PrRef[]): PrTone => prs.map(prTone).reduce((a, b) => (b.urgency > a.urgency ? b : a));

// The card/meta indicator for a task's PRs. Renders nothing with no PRs; one PR
// links straight to GitHub; several show an "N PRs" chip that opens a bottom
// sheet listing them all. The chip can sit inside the tappable task row, so the
// trigger (and the single-PR link) stop propagation to keep the row from
// navigating. The sheet itself is deliberately NOT wrapped in a stop-propagation
// span — that wrapper swallowed vaul's tap-the-scrim-to-dismiss (the overlay
// click). Its portaled events still bubble through the React tree to the row, but
// the row ignores clicks whose target isn't inside it (Inbox's navIfInRow), so
// dismissing the sheet never navigates the row.
export function PrChip({ prs }: { prs?: PrRef[] }) {
  const [open, setOpen] = useState(false);
  if (!prs?.length) return null;
  const tone = topTone(prs);
  const dot = <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />;

  if (prs.length === 1) {
    const pr = prs[0];
    return (
      <a
        className="inline-flex items-center gap-1 font-semibold text-blue hover:underline"
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        {dot}
        PR #{pr.number}
      </a>
    );
  }

  return (
    <>
      <span
        role="button"
        tabIndex={0}
        aria-label={`${prs.length} pull requests`}
        className="inline-flex cursor-pointer items-center gap-1 font-semibold text-blue hover:underline"
        // Open the sheet without letting the tap reach an enclosing tappable row.
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {dot}
        {prs.length} PRs
      </span>
      <PrSheet prs={prs} open={open} onOpenChange={setOpen} />
    </>
  );
}

function PrSheet({ prs, open, onOpenChange }: { prs: PrRef[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Pull requests</SheetTitle>
          <SheetDescription>{prs.length} opened in this task</SheetDescription>
        </SheetHeader>
        <ul className="flex max-h-[60vh] flex-col overflow-y-auto px-2 pb-1">
          {prs.map((pr) => {
            const tone = prTone(pr);
            return (
              <li key={pr.url}>
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors active:bg-accent"
                >
                  <span aria-hidden className={cn("mt-[5px] size-2 shrink-0 rounded-full", tone.dot)} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="shrink-0 text-[13px] font-semibold text-strong">#{pr.number}</span>
                      <span className="truncate text-[14px] text-foreground">{pr.title ?? pr.repo}</span>
                    </span>
                    <span className={cn("mt-0.5 block truncate text-[12px]", tone.text)}>
                      {tone.label}
                      {pr.branch ? ` · ${pr.branch}` : ""}
                    </span>
                  </span>
                  <ArrowUpRight aria-hidden className="mt-0.5 size-4 shrink-0 text-faint" />
                </a>
              </li>
            );
          })}
        </ul>
      </SheetContent>
    </Sheet>
  );
}
