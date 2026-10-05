import { BackLayerScope, useBackDismiss } from "@/hooks/useBackLayer";
import * as React from "react";
import { ScrollArea } from "./scroll-area";
import { Drawer as DrawerPrimitive } from "vaul";

import { cn } from "@/lib/utils";

// vaul bottom drawer — replaces the hand-rolled .sheet/.sheet-scrim bottom
// sheet (drag-to-dismiss, scrim and body scroll lock come from the library).
function Drawer(props: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  const { depth, ...back } = useBackDismiss(props);
  return <BackLayerScope depth={depth}><DrawerPrimitive.Root data-slot="drawer" {...props} {...back} /></BackLayerScope>;
}

function DrawerTrigger(props: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal(props: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose(props: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
  return (
    <DrawerPrimitive.Overlay
      data-slot="drawer-overlay"
      className={cn("fixed inset-0 z-50 bg-black/60", className)}
      {...props}
    />
  );
}

function DrawerContent({
  className,
  children,
  side = "bottom",
  size = "content",
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content> & { side?: "bottom" | "left"; size?: "content" | "panel" }) {
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          "fixed z-50 flex min-h-0 flex-col bg-card",
          side === "left" ? "inset-y-0 left-0 h-app w-[min(88vw,340px)] border-r border-border" : "inset-x-0 bottom-0 mx-auto h-auto max-h-[min(90dvh,calc(var(--app-height,100dvh)-16px))] w-full max-w-[720px] rounded-t-3xl border border-b-0 border-border pb-[var(--safe-bottom,0px)]",
          side === "bottom" && size === "panel" && "h-[680px]",
          className,
        )}
        {...props}
      >
        {side === "bottom" && <div aria-hidden="true" className="mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-input" />}
        {children}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn("flex shrink-0 flex-col gap-1 px-4 pt-2 pb-1", className)}
      {...props}
    />
  );
}

// Use a row for titles with navigation or close controls; long titles wrap.
function DrawerHeaderRow({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="drawer-header-row" className={cn("flex min-h-11 min-w-0 items-center gap-2", className)} {...props} />;
}

// Only the body scrolls. The content owns the viewport cap and safe-area inset,
// so short sheets fit their content and long sheets keep their actions reachable.
function DrawerBody({ className, hidden, ...props }: Omit<React.ComponentProps<typeof ScrollArea>, "contentClassName" | "viewportProps">) {
  return <ScrollArea data-slot="drawer-body" hidden={hidden} className={cn("flex-1", hidden && "hidden")}
    contentClassName={cn("min-w-0 px-4 pt-3 pb-4", className)} {...props} />;
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn(
        "flex shrink-0 flex-col gap-2 px-4 pt-1 pb-4",
        className,
      )}
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("min-w-0 flex-1 text-base font-semibold text-strong [overflow-wrap:anywhere]", className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-sm text-muted-foreground [overflow-wrap:anywhere]", className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerHeaderRow,
  DrawerBody,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
};
