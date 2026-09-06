import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Plane-1 object surface. `shadow-sm` is a hairline lift in LIGHT only; DARK
// conveys elevation via --card being lighter than --background (luminance), so
// the shadow utility is intentionally near-invisible there.
const cardVariants = cva(
  "rounded-xl border border-border bg-card text-card-foreground shadow-sm dark:shadow-none",
  {
    variants: {
      variant: {
        default: "",
        // Tap feedback for a card wrapped in a <button> (e.g. priority Inbox
        // rows). No hover-lift — this is a touch-first app.
        interactive: "transition-colors active:bg-accent",
        // Status-tinted left rail + faint tinted bg for awaiting_* surfaces.
        // Consumer injects the rail color via className (e.g.
        // `border-l-status-input-fg bg-status-input-bg`).
        attention: "border-l-[3px]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Card({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return <div data-slot="card" className={cn(cardVariants({ variant }), className)} {...props} />;
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex flex-col gap-1 p-4", className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("text-[15px] leading-5 font-semibold text-card-foreground", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-[12.5px] leading-4 text-faint", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("p-4 pt-0", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-footer" className={cn("flex items-center gap-2 p-4 pt-0", className)} {...props} />
  );
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, cardVariants };
