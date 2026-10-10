import { BackLayerScope, useBackDismiss } from "@/hooks/useBackLayer";
import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";

import { Button } from "./button";
import { ScrollArea } from "./scroll-area";
import { cn } from "@/lib/utils";

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const { depth, ...back } = useBackDismiss(props);
  return <BackLayerScope depth={depth}><DialogPrimitive.Root data-slot="dialog" {...props} {...back} /></BackLayerScope>;
}

function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal(props: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showClose?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-close={showClose || undefined}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(var(--app-height,100dvh)-2rem)] flex-col overflow-hidden w-[calc(100%-2rem)] max-w-[400px] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg [&[data-close]_[data-slot=dialog-header]]:pr-10 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon" className="absolute top-0.5 right-0.5 size-11" aria-label="Close">
              <X />
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogBody(props: React.ComponentProps<typeof ScrollArea>) {
  return <ScrollArea data-slot="dialog-body" {...props} />;
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex shrink-0 flex-col gap-1.5", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex shrink-0 flex-col-reverse gap-2 [&>button]:w-full sm:flex-row sm:justify-end sm:[&>button]:w-auto", className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-base leading-6 font-semibold text-strong", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-[13px] leading-5 text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogBody,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
