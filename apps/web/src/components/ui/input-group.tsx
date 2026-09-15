import * as React from "react";
import { cn } from "@/lib/utils";

// Compound input surface. Addons follow the control in the DOM; their alignment
// controls visual order without remounting the textarea when focus changes.
function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="input-group" role="group" className={cn(
    "flex min-w-0 flex-wrap items-center border border-input bg-card focus-within:border-ring",
    className,
  )} {...props} />;
}

function InputGroupAddon({ align = "inline-start", className, ...props }: React.ComponentProps<"div"> & {
  align?: "inline-start" | "inline-end" | "block-start" | "block-end";
}) {
  return <div data-slot="input-group-addon" data-align={align} className={cn(
    "flex items-center",
    align === "inline-start" && "order-first",
    align === "inline-end" && "order-last",
    align === "block-start" && "order-first w-full",
    align === "block-end" && "order-last w-full",
    className,
  )} {...props} />;
}

const InputGroupTextarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => <textarea ref={ref} data-slot="input-group-control" className={cn(
    "min-w-0 flex-1 resize-none border-0 bg-transparent text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-40",
    className,
  )} {...props} />,
);
InputGroupTextarea.displayName = "InputGroupTextarea";

export { InputGroup, InputGroupAddon, InputGroupTextarea };
