import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Rhea surface with Palmagent's status variants and content-owned padding.
const cardVariants = cva(
  "rounded-[min(var(--radius-4xl),24px)] border-border bg-card text-sm text-card-foreground shadow-sm ring-1 ring-foreground/5 dark:ring-foreground/10",
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
  return <div data-slot="card-header" className={cn("flex flex-col gap-1.5 p-4", className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("font-heading text-base leading-5 font-medium text-card-foreground", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm leading-5 text-muted-foreground", className)}
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
