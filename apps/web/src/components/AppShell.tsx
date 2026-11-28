import { Spinner } from "@/components/ui/spinner";
import type { ReactNode } from "react";
import { ChevronLeft, Menu } from "lucide-react";

import { IconButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConnState } from "../hooks/useInbox";
import { goBack } from "../router";
import { useAppNavigation } from "./AppNavigation";
import { useUpdateFeedback } from "./UpdateFeedback";

export function AppShell({
  children,
  wide,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  return <div className={cn("mx-auto flex h-full flex-col", wide ? "max-w-[1100px]" : "max-w-[720px]")}>{children}</div>;
}

// Standard focused views preserve Back; conversations use a compact floating toolbar.
export function AppBar({
  title,
  back,
  backLabel = "Back",
  onBack,
  conn,
  conversation,
  transparent,
  compactHeader,
  className,
  children,
}: {
  title: string;
  back?: boolean;
  backLabel?: string;
  onBack?: () => void;
  /** When provided, a small live-state dot renders beside the title. */
  conn?: ConnState;
  /** Minimal navigation and task actions over a scrolling conversation. */
  conversation?: boolean;
  /** Static translucent header that overlays its view content. */
  transparent?: boolean;
  /** Let the header action replace the visible title on narrow views. */
  compactHeader?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const navigation = useAppNavigation();
  const floating = conversation || transparent;
  const floatingButton = "pointer-events-auto relative z-10 touch-pan-y border-border bg-card/85 backdrop-blur-md";
  const menu = navigation && <IconButton className={cn(navigation.desktopSidebar && "hidden", floating && floatingButton)} aria-label="Open navigation" onClick={(event) => navigation.openNavigation(event.currentTarget)}><Menu /></IconButton>;
  return (
    <header
      className={cn("sticky top-0 z-10 flex items-center gap-2 px-3 pt-[calc(10px+var(--safe-top))] pb-2.5", floating ? "isolate justify-between pointer-events-none" : "bg-background/95 backdrop-blur-md before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-[var(--safe-top)] before:bg-background before:content-['']", className)}
      style={floating ? { marginBottom: "calc(-64px - var(--safe-top))" } : undefined}
    >
      {floating && <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[calc(96px+var(--safe-top))] bg-linear-to-b from-background/70 via-background/35 to-transparent" />}
      {conversation ? <>
        {menu}
        <h1 className="sr-only">{title}</h1>
        {children && <div role="group" aria-label="Header actions" className="relative z-10 ml-auto inline-flex shrink-0 items-center rounded-full border border-border bg-card/85 backdrop-blur-md pointer-events-auto [&_button]:touch-pan-y">{children}</div>}
        {conn && <ReconnectStatus conn={conn} visuallyHidden />}
      </> : compactHeader ? <>
        {back && <IconButton className={floatingButton} onClick={onBack ?? (() => goBack())} aria-label={backLabel}><ChevronLeft /></IconButton>}
        <h1 className="sr-only">{title}</h1>
        {children && <div role="group" aria-label="Header actions" className="relative z-10 inline-flex min-w-0 flex-1 items-center rounded-full border border-border bg-card/85 backdrop-blur-md pointer-events-auto [&_button]:touch-pan-y">{children}</div>}
        {menu}
        {conn && <ReconnectStatus conn={conn} visuallyHidden />}
      </> : <>
        {!back && menu}
        {back && (
          <IconButton className={cn("-ml-1.5", floating && floatingButton)} onClick={onBack ?? (() => goBack())} aria-label={backLabel}>
            <ChevronLeft />
          </IconButton>
        )}
        <h1 className="flex min-w-0 flex-1 items-center gap-2 truncate text-[17px] font-semibold text-strong">
          <span className="min-w-0 truncate">{title}</span>
          {conn && <ReconnectStatus conn={conn} />}
        </h1>
        {back && children && menu ? (
          <div role="group" aria-label="Header actions" className="-my-px inline-flex shrink-0 items-center rounded-full border border-border bg-card/90 backdrop-blur-md pointer-events-auto [&_button]:touch-pan-y">
            {children}
            {menu}
          </div>
        ) : (
          <>
            {children}
            {back && menu}
          </>
        )}
      </>}
    </header>
  );
}

export function ReconnectStatus({ conn, visuallyHidden, className }: { conn: ConnState; visuallyHidden?: boolean; className?: string }) {
  const updating = useUpdateFeedback();
  if (updating || conn !== "reconnecting") return null;
  if (visuallyHidden) return <span role="status" title="Reconnecting…" className="sr-only">Reconnecting…</span>;
  return (
    <span role="status" title="Reconnecting…" className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-medium text-amber", className)}>
      <span aria-hidden className="size-2 shrink-0 motion-safe:animate-pulse rounded-full bg-amber" />
      Reconnecting…
    </span>
  );
}

// SSE connection indicator. Kept as a labeled pill for the Settings sheet's
// Connection row (and any screen that still wants the textual form).
export function ConnPill({ conn, compact }: { conn: ConnState; compact?: boolean }) {
  const label =
    conn === "open" ? "live" : conn === "connecting" ? "connecting…" : "reconnecting…";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
      {conn === "connecting" ? <Spinner className="size-3" /> : <span
        className={cn(
          "size-2 rounded-full",
          conn === "open" ? "bg-live" : conn === "reconnecting" ? "motion-safe:animate-pulse bg-amber" : "bg-faint",
        )}
      />}
      <span className={compact && conn === "connecting" ? "sr-only" : undefined}>{label}</span>
    </span>
  );
}
