import type { ReactNode } from "react";
import { Collapsible } from "radix-ui";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

// Keep the full content out of the collapsed DOM while retaining an accessible,
// keyboard-operable 44px trigger. Radix owns aria-expanded and aria-controls.
export function Disclosure({ label, children, open, onOpenChange }: {
  label: string;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return <Collapsible.Root open={open} onOpenChange={onOpenChange} className="min-w-0">
    <Collapsible.Trigger asChild>
      <Button variant="ghost" className="group w-full justify-start px-0" title={label}>
        <ChevronRight data-icon="inline-start" className="group-data-[state=open]:rotate-90" />
        <span className="truncate">{label}</span>
      </Button>
    </Collapsible.Trigger>
    <Collapsible.Content className="min-w-0 pb-2">{children}</Collapsible.Content>
  </Collapsible.Root>;
}
