import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Sizes run taller than stock shadcn: this is a phone-first app, so the
// default hit target is 44px.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-40 aria-disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 outline-none aria-invalid:border-destructive aria-invalid:ring-destructive/20 focus-visible:ring-2 focus-visible:ring-ring/50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground border border-primary-active active:bg-primary-active",
        selected: "bg-accent text-accent-foreground border border-transparent active:bg-primary/15",
        secondary: "bg-card text-foreground border border-input font-medium active:bg-accent",
        destructive: "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline: "border border-input bg-transparent text-foreground active:bg-accent",
        floating: "border border-border bg-background/70 text-foreground shadow-sm hover:bg-background/85 active:bg-background/90",
        ghost: "text-foreground active:bg-accent",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-4",
        title: "h-11 min-w-0 justify-start px-0 text-[17px]",
        navigation: "h-12 w-full justify-start gap-3 rounded-xl border-transparent px-3 text-base font-medium [&_svg[data-icon='inline-start']]:size-5",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-9 px-3 text-[13px]",
        lg: "h-12 px-6",
        icon: "size-10",
        "icon-lg": "size-11 rounded-full p-0 [&_svg:not([class*='size-'])]:size-5",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 rounded-full text-[13px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

// Forward the ref to preserve the anchor used by asChild menu and popover triggers.
const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }
>(({ className, variant = "default", size = "default", asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp ref={ref} data-slot="button" data-variant={variant} data-size={size} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  );
});
Button.displayName = "Button";

export { Button, buttonVariants };
