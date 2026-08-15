import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Sizes run taller than stock shadcn: this is a phone-first app, so the
// default hit target is 44px.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground border border-primary-active active:bg-primary-active",
        secondary: "bg-card text-foreground border border-input font-medium active:bg-accent",
        destructive: "bg-destructive-bg text-destructive border border-destructive-border active:bg-destructive/15",
        outline: "border border-input bg-transparent text-foreground active:bg-accent",
        ghost: "text-foreground active:bg-accent",
        link: "text-blue underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-4",
        sm: "h-9 px-3 text-[13px]",
        lg: "h-12 px-6",
        icon: "size-10",
        "icon-sm": "size-8 rounded-full text-[13px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

// MUST forward refs. We're on React 18, where a plain function component
// silently DROPS any ref passed to it. When a Radix Popper trigger wraps this
// Button with `asChild` (e.g. `<DropdownMenuTrigger asChild><Button/>`), Radix
// sets a ref on the Button to register it as the floating-ui ANCHOR. A dropped
// ref means the menu has no anchor, so floating-ui never positions it and the
// content renders offscreen at `translate(0,-200%)` — i.e. the trigger appears
// to "do nothing" on tap. forwardRef makes the ref reach the real <button>.
const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }
>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp ref={ref} data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
  );
});
Button.displayName = "Button";

export { Button, buttonVariants };
