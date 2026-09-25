import type { CSSProperties, ReactNode } from "react";
import { ChevronLeft, Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConnState } from "../hooks/useInbox";
import { usePwaUpdate } from "../pwa";
import { goBack } from "../router";
import { useAppNavigation } from "./AppNavigation";
import { UpdateBanner } from "./UpdateBanner";

// Shared viewport shell. The update banner stays in flow; fixed actions read
// its height so content remains reachable above device safe areas.
export function AppShell({
  children,
  wide,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  const updateReady = usePwaUpdate();
  return (
    <div
      className={cn("mx-auto flex h-app flex-col", wide ? "max-w-[1100px]" : "max-w-[720px]")}
      style={
        {
          "--banner-h": updateReady ? "60px" : "0px",
        } as CSSProperties
      }
    >
      {children}
      {updateReady && <UpdateBanner />}
    </div>
  );
}

// Focused views preserve Back; navigation stays available on every app route.
export function AppBar({
  title,
  titleControl,
  back,
  conn,
  children,
}: {
  title: string;
  /** Optional accessible title trigger for focused-screen details. */
  titleControl?: ReactNode;
  back?: boolean;
  /** When provided, a small live-state dot renders beside the title. */
  conn?: ConnState;
  children?: ReactNode;
}) {
  const navigation = useAppNavigation();
  const menu = navigation && <Button variant="ghost" size="icon-lg" className="shrink-0 rounded-full" aria-label="Open navigation" onClick={(event) => navigation.openNavigation(event.currentTarget)}><Menu className="size-5" /></Button>;
  return (
    // Paint the safe-area strip solid behind the translucent header.
    <header className="sticky top-0 z-10 flex items-center gap-2 bg-background/95 px-3 pt-[calc(10px+var(--safe-top))] pb-2.5 backdrop-blur-md before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-[var(--safe-top)] before:bg-background before:content-['']">
      {!back && menu}
      {back && (
        <Button variant="ghost" size="icon-lg" className="-ml-1.5 rounded-full" onClick={goBack} aria-label="Back">
          <ChevronLeft className="size-6" />
        </Button>
      )}
      <h1 className="flex min-w-0 flex-1 items-center gap-2 truncate text-[17px] font-semibold text-strong">
        {titleControl ?? <span className="min-w-0 truncate">{title}</span>}
        {conn && <LiveDot conn={conn} compact={Boolean(titleControl)} />}
      </h1>
      {back && children && menu ? (
        <div role="group" aria-label="Header actions" className="-my-px inline-flex shrink-0 items-center rounded-full border border-border bg-card/90 backdrop-blur-md">
          {children}
          {menu}
        </div>
      ) : (
        <>
          {children}
          {back && menu}
        </>
      )}
    </header>
  );
}

// Connection state in the AppBar title row, "calm" by design: a healthy/open
// link — and the brief initial `connecting` — render NOTHING. Green is reserved
// app-wide for a running task state indicator, not for "we're
// connected", so the header never competes for that meaning. Only a real
// `reconnecting` surfaces, as an amber pulse dot + short label, so a connection
// problem is the single thing that ever draws the eye here. The all-states
// labeled form still lives in ConnPill (the Settings → Connection row).
function LiveDot({ conn, compact = false }: { conn: ConnState; compact?: boolean }) {
  if (conn !== "reconnecting") return null;
  return (
    <span role="status" title="Reconnecting…" className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-amber">
      <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-amber" />
      <span className={compact ? "sr-only" : undefined}>Reconnecting…</span>
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
