import { BarChart3, CalendarClock, Inbox } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { navigate } from "../router";

// Bottom tab bar — the app's primary travel surface. A full-width edge bar (NOT
// a floating pill), sibling of the scroll pane inside the 720px column, pinned to
// the bottom in normal flex flow (so it shrinks the scroll pane rather than
// overlapping it). Rendered by AppShell only on the three root routes.
//
// The Usage/Routines aria-labels (formerly on Inbox header icon-buttons) now live
// on these tab buttons, so getByRole("link"|"button", { name: "Usage"/"Routines" })
// still resolves after the IA change.

type RootRoute = "inbox" | "routines" | "usage";

const TABS: { route: RootRoute; path: string; icon: LucideIcon; label: string; ariaLabel?: string }[] = [
  { route: "inbox", path: "/", icon: Inbox, label: "Tasks" },
  { route: "routines", path: "/routines", icon: CalendarClock, label: "Routines", ariaLabel: "Routines" },
  { route: "usage", path: "/usage", icon: BarChart3, label: "Usage", ariaLabel: "Usage" },
];

export function TabBar({ active, attention }: { active: string; attention?: boolean }) {
  return (
    <nav
      // Plane-2 floating chrome: translucent surface + blur + hairline top border.
      // Height (64px) is mirrored by --tabbar-h on the shell so the FAB/content clear it.
      //
      // Same fix as the header's status-bar band, for the bottom nav-bar/home-
      // indicator strip (reserved by pb-[--safe-bottom]). The TabBar fills that
      // strip with its TRANSLUCENT bg-background/85, so whatever's behind it bleeds
      // through — and whether the body background even paints below `innerHeight`
      // into the gesture inset varies by Android version. The `after:` band repaints
      // the strip a solid, OPAQUE --background so the nav-bar-adjacent color is
      // deterministic and matches the header band + theme-color. 0px (inert)
      // without an inset. `relative` anchors the absolute band to the nav.
      className="relative flex shrink-0 items-stretch border-t border-border bg-background/85 pb-[var(--safe-bottom)] backdrop-blur-md after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-[var(--safe-bottom)] after:bg-background after:content-['']"
      aria-label="Primary"
    >
      {TABS.map(({ route, path, icon: Icon, label, ariaLabel }) => {
        const isActive = route === active;
        return (
          <button
            key={route}
            type="button"
            aria-label={ariaLabel}
            aria-current={isActive ? "page" : undefined}
            onClick={() => navigate(path)}
            className={cn(
              "relative flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 pt-1.5 pb-1 text-[11px] font-medium outline-none transition-colors active:bg-accent",
              isActive ? "text-primary" : "text-faint",
            )}
          >
            {/* 2px active accent rule along the top edge of the active tab. */}
            {isActive && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-primary" />}
            <span className="relative">
              <Icon className="size-[22px]" />
              {route === "inbox" && attention && (
                // Attention dot: any task awaiting input/approval. No pulse/animation.
                <span
                  aria-hidden
                  className="absolute -top-0.5 -right-1 size-2 rounded-full bg-amber ring-2 ring-background"
                />
              )}
            </span>
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
