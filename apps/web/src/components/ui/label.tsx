import * as React from "react";
import { Label as LabelPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Label({ className, variant = "default", ...props }: React.ComponentProps<typeof LabelPrimitive.Root> & { variant?: "default" | "setting" }) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn("block leading-none select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50", variant === "setting" ? "text-sm font-medium text-foreground" : "text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Label };
