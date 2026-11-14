import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

// Shared empty state — centered icon badge + title + subline + optional CTA.
// Used by Inbox / Routines / Usage when they have nothing to show.
export function EmptyState({
  icon: Icon,
  title,
  subtitle,
  action,
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  /** Optional primary CTA. */
  action?: { label: string; onClick: () => void };
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-faint">
        <Icon className="size-6" />
      </span>
      <p className="mt-4 text-[15px] font-semibold text-strong">{title}</p>
      {subtitle && <p className="mt-1 max-w-[260px] text-[12.5px] break-words text-faint">{subtitle}</p>}
      {children && <div className="mt-5 flex w-full max-w-xs flex-col items-center gap-3">{children}</div>}
      {action && (
        <Button className="mt-5" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
