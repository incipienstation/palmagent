import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";

import { cn } from "@/lib/utils";

function Label({ className, variant = "default", ...props }: React.ComponentProps<typeof LabelPrimitive.Root> & { variant?: "default" | "setting" }) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn("block leading-none select-none", variant === "setting" ? "text-sm font-medium text-foreground" : "text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Label };
