import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentPropsWithoutRef<"input">>(function Input({ className, type, ...props }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(
        "flex h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-[15px] text-foreground placeholder:text-faint outline-none transition-colors focus-visible:border-blue disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
});

export { Input };
