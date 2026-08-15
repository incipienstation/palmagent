import * as React from "react";

import { cn } from "@/lib/utils";

// Deterministic pulse loader. The mock harness renders LOADED state, so
// skeletons never appear in visual snapshots — the pulse is purely runtime.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="skeleton" className={cn("animate-pulse rounded-lg bg-muted", className)} {...props} />
  );
}

export { Skeleton };
