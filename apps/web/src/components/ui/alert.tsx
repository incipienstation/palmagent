import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Extra "info"/"warning" variants carry the steer-notice colors the app used
// before the shadcn migration (injected = blue, queued = amber).
const alertVariants = cva("w-full rounded-lg border px-3 py-2 text-[13px]", {
  variants: {
    variant: {
      default: "bg-muted border-border text-foreground",
      destructive: "bg-destructive-bg border-destructive-border text-destructive",
      info: "bg-status-running-bg border-status-running-bg text-status-running-fg",
      warning: "bg-status-approval-bg border-status-approval-bg text-status-approval-fg",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

export { Alert, alertVariants };
