import type { CSSProperties, ReactNode } from "react";
import { ChevronLeft, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConnState } from "../hooks/useInbox";
import { usePwaUpdate } from "../pwa";
import { goBack, useRoute } from "../router";
import { SettingsSheet } from "./SettingsSheet";
import { TabBar } from "./TabBar";
import { UpdateBanner } from "./UpdateBanner";

// Root routes get the bottom TabBar (travel) + the gear AppBar (Settings sheet);
// focused routes (Dispatch / TaskDetail / Auth / Enroll) get a back-chevron AppBar
// and no tab bar. Keep this in sync with router.ts's route names.
const ROOT_ROUTES = new Set(["inbox", "routines", "usage"]);

// Shared phone-frame shell: full-height column capped at 720px. Bottom stack
// (all in normal flex flow except the FAB): [scroll content] → [TabBar, root
// routes only] → [UpdateBanner, when a deploy lands]. Because the TabBar +
// banner live in flow they shrink the scroll pane and never overlap it — the
// document itself still never scrolls (assertViewportLocked).
//
// Two CSS custom properties cascade to the fixed FAB (which escapes flow) so it
// can clear both chrome elements:
//   --banner-h  0px / 60px   (verbatim from the pre-redesign shell; the
//               [style*="--banner-h"] selector must keep matching)
//   --tabbar-h  64px / 0px   (sibling added for the new bottom nav)
// The Toaster viewport reads both (with 0px fallbacks) and is mounted app-wide
// in main.tsx so toasts work on every route incl. the auth gate.
export function AppShell({
  children,
  attention,
}: {
  children: ReactNode;
  /** Inbox passes this so the Inbox tab shows an attention dot when any task
      is awaiting input/approval (it owns the task list; the shell stays data-agnostic). */
  attention?: boolean;
}) {
  const updateReady = usePwaUpdate();
  const route = useRoute();
  const isRoot = ROOT_ROUTES.has(route.name);
  return (
    <div
      className="mx-auto flex h-app max-w-[720px] flex-col"
      style={
        {
          "--banner-h": updateReady ? "60px" : "0px",
          "--tabbar-h": isRoot ? "64px" : "0px",
        } as CSSProperties
      }
    >
      {children}
      {isRoot && <TabBar active={route.name} attention={attention} />}
      {updateReady && <UpdateBanner />}
    </div>
  );
}

// Conventions for screen agents (READ THIS):
//   - Root screens (Tasks/Routines/Usage): <AppBar title="…" brand conn={conn} settings />.
//     All three carry the small brand mark (left) + their own functional title — the
//     brand stays present app-wide while each tab header reads as its own page. They
//     no longer render their own Usage/Routines/Push/Sign-out header buttons — those
//     moved into the TabBar (Usage/Routines) and the Settings sheet (Push/Sign out/
//     theme). The gear button is rendered for you by `settings`.
//   - Focused screens (Dispatch/TaskDetail): <AppBar title="…" back /> (+ conn for the
//     compact live dot on TaskDetail). No gear.
//   - Extra trailing controls still go in `children` (rendered before the gear).
export function AppBar({
  title,
  back,
  settings,
  conn,
  brand,
  children,
}: {
  title: string;
  back?: boolean;
  /** Render the gear (right) that opens the Settings sheet — root screens only. */
  settings?: boolean;
  /** When provided, a small live-state dot renders beside the title. */
  conn?: ConnState;
  /** Render the small brand mark before the title — set on all root screens so
      the brand stays present while the title text stays functional (Tasks/
      Routines/Usage). Focused screens (back-chevron) omit it. */
  brand?: boolean;
  children?: ReactNode;
}) {
  return (
    // The header extends its background up into the status-bar strip via the
    // pt-[…+--safe-top] padding, but that background is TRANSLUCENT (bg-background/85
    // + backdrop-blur). Whatever sits behind that strip bleeds through the 85% and
    // shifts its color off the SOLID OS status bar (painted by <meta theme-color> =
    // --background) → a seam at the OS boundary. And what's behind it isn't reliably
    // --background: the page canvas under the inset can be the manifest's dark
    // background_color (visible in LIGHT mode) or bare canvas when innerHeight
    // excludes the inset. The `before:` band repaints just that strip a solid,
    // OPAQUE --background on top, so it always equals theme-color in both themes
    // (theme-color tracks --background via the index.html bootstrap + ThemeProvider).
    // Content stays below it via the same pt padding; 0px and inert without an inset.
    <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/85 px-3 pt-[calc(10px+var(--safe-top))] pb-2.5 backdrop-blur-md before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-[var(--safe-top)] before:bg-background before:content-['']">
      {back && (
        <Button variant="ghost" size="icon-sm" className="-ml-1.5 text-blue" onClick={goBack} aria-label="Back">
          <ChevronLeft className="size-6" />
        </Button>
      )}
      <h1 className="flex min-w-0 flex-1 items-center gap-2 truncate text-[17px] font-semibold text-strong">
        {brand && <BrandMark className="size-[22px] shrink-0 text-primary" />}
        <span className="min-w-0 truncate">{title}</span>
        {conn && <LiveDot conn={conn} />}
      </h1>
      {children}
      {settings && (
        <SettingsSheet conn={conn}>
          <Button variant="ghost" size="icon-sm" className="text-faint" aria-label="Settings">
            <Settings className="size-5" />
          </Button>
        </SettingsSheet>
      )}
    </header>
  );
}

// PalmAgent brand mark — the "Digital Bars" palm glyph (fingers over a palm
// bar), drawn in currentColor so it inherits the teal `text-primary` and adapts
// per theme. Mirrors public/favicon.svg + the app-icon set (keep them in sync).
function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="currentColor" aria-hidden className={className}>
      <rect x="9" y="24" width="6" height="20" rx="3" />
      <rect x="19" y="16" width="6" height="28" rx="3" />
      <rect x="29" y="10" width="6" height="34" rx="3" />
      <rect x="39" y="14" width="6" height="30" rx="3" />
      <rect x="49" y="22" width="6" height="22" rx="3" />
      <rect x="9" y="48" width="46" height="6" rx="3" />
    </svg>
  );
}

// Connection state in the AppBar title row, "calm" by design: a healthy/open
// link — and the brief initial `connecting` — render NOTHING. Green is reserved
// app-wide for a *running task* (the Inbox headline dot), not for "we're
// connected", so the header never competes for that meaning. Only a real
// `reconnecting` surfaces, as an amber pulse dot + short label, so a connection
// problem is the single thing that ever draws the eye here. The all-states
// labeled form still lives in ConnPill (the Settings → Connection row).
function LiveDot({ conn }: { conn: ConnState }) {
  if (conn !== "reconnecting") return null;
  return (
    <span role="status" className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-amber">
      <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-amber" />
      Reconnecting…
    </span>
  );
}

// SSE connection indicator. Kept as a labeled pill for the Settings sheet's
// Connection row (and any screen that still wants the textual form).
export function ConnPill({ conn, compact }: { conn: ConnState; compact?: boolean }) {
  const label =
    conn === "open" ? "live" : conn === "connecting" ? (compact ? "…" : "connecting…") : "reconnecting…";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
      <span
        className={cn(
          "size-2 rounded-full",
          conn === "open" ? "bg-live" : conn === "reconnecting" ? "animate-pulse bg-amber" : "bg-faint",
        )}
      />
      {label}
    </span>
  );
}
