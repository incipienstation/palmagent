import * as React from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

// Keep existing enum pickers segmented; settings opt into the shadcn outline style.
const ToggleGroupVariant = React.createContext<"segmented" | "pills" | "outline">("segmented");
function ToggleGroup({
  className,
  children,
  variant = "segmented",
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> & { variant?: "segmented" | "pills" | "outline" }) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      className={cn("flex items-stretch", variant === "outline" ? "w-fit rounded-2xl" : "w-full", variant === "pills" ? "flex-wrap gap-2" : variant === "segmented" && "overflow-hidden rounded-2xl border border-input", className)}
      {...props}
    >
      <ToggleGroupVariant.Provider value={variant}>{children}</ToggleGroupVariant.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

function ToggleGroupItem({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & { variant?: "segmented" | "list" | "pill" | "outline" }) {
  const groupVariant = React.useContext(ToggleGroupVariant);
  const itemVariant = variant ?? (groupVariant === "outline" ? "outline" : "segmented");
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={itemVariant}
      className={cn(
        "flex h-11 items-center justify-center outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-40",
        itemVariant === "outline"
          ? "relative min-w-11 shrink-0 border border-l-0 first:border-l border-input bg-transparent px-3 text-sm font-medium whitespace-nowrap text-muted-foreground first:rounded-l-2xl last:rounded-r-2xl hover:bg-muted hover:text-foreground focus-visible:z-10 data-[state=on]:bg-muted data-[state=on]:text-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
          : "flex-1 border-l border-input bg-background px-1.5 text-[13px] text-muted-foreground first:border-l-0 data-[state=on]:bg-accent data-[state=on]:font-semibold data-[state=on]:text-accent-foreground",
        itemVariant === "pill" && "flex-none rounded-full border px-3 first:border-l",
        itemVariant === "list" && "h-auto min-h-12 flex-none justify-between gap-3 border-t border-l-0 px-4 py-3 text-left text-base first:border-t-0",
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { ToggleGroup, ToggleGroupItem };
