import * as React from "react";
import { Toast as ToastPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

import { cn } from "@/lib/utils";

const ToastProvider = ToastPrimitive.Provider;

function ToastViewport({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      // Docked bottom-center, above the tab bar + banner stack (see AppShell).
      className={cn(
        "fixed left-1/2 z-[60] flex w-[calc(100%-2rem)] max-w-[400px] -translate-x-1/2 flex-col gap-2 outline-none",
        className,
      )}
      style={{
        bottom: "calc(var(--tabbar-h, 0px) + var(--banner-h, 0px) + 12px + var(--safe-bottom))",
      }}
      {...props}
    />
  );
}

// Plane-2 elevation; each variant adds a colored left rail.
const toastVariants = cva(
  "group pointer-events-auto relative flex w-full items-start gap-2.5 overflow-hidden rounded-xl border border-border bg-popover/95 p-3 pr-9 text-popover-foreground shadow-md backdrop-blur-md data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-2 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-80 data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform data-[swipe=end]:animate-out data-[swipe=end]:fade-out-80",
  {
    variants: {
      variant: {
        default: "border-l-4 border-l-border",
        success: "border-l-4 border-l-green",
        info: "border-l-4 border-l-blue",
        destructive: "border-l-4 border-l-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const ICONS = {
  default: CheckCircle2,
  success: CheckCircle2,
  info: Info,
  destructive: AlertTriangle,
} as const;

const ICON_COLOR = {
  default: "text-faint",
  success: "text-green",
  info: "text-blue",
  destructive: "text-destructive",
} as const;

type ToastVariant = NonNullable<VariantProps<typeof toastVariants>["variant"]>;

function Toast({
  className,
  variant = "default",
  title,
  description,
  ...props
}: Omit<React.ComponentProps<typeof ToastPrimitive.Root>, "title"> &
  VariantProps<typeof toastVariants> & {
    title?: React.ReactNode;
    description?: React.ReactNode;
  }) {
  const v = (variant ?? "default") as ToastVariant;
  const Icon = ICONS[v];
  return (
    <ToastPrimitive.Root data-slot="toast" className={cn(toastVariants({ variant }), className)} {...props}>
      <Icon className={cn("mt-px size-4 shrink-0", ICON_COLOR[v])} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title && (
          <ToastPrimitive.Title className="text-[13px] leading-5 font-semibold text-strong [overflow-wrap:anywhere]">
            {title}
          </ToastPrimitive.Title>
        )}
        {description && (
          <ToastPrimitive.Description className="text-[12.5px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
            {description}
          </ToastPrimitive.Description>
        )}
      </div>
      <ToastPrimitive.Close
        className="absolute top-2.5 right-2.5 rounded-md p-0.5 text-faint opacity-70 outline-none transition-opacity active:opacity-100"
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}

export { Toast, ToastProvider, ToastViewport, toastVariants };
export type { ToastVariant };
