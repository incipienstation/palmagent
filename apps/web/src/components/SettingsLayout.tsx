import type { ComponentProps, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Field, FieldGroup } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export function SettingsPanel({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("flex min-w-0 flex-col gap-4", className)} {...props} />;
}

export function SettingsCard({ className, ...props }: ComponentProps<typeof FieldGroup>) {
  return <FieldGroup className={cn("gap-0 rounded-xl border border-border bg-background/50 px-3", className)} {...props} />;
}

export function SettingsField({ className, orientation = "horizontal", ...props }: ComponentProps<typeof Field>) {
  return <Field orientation={orientation} className={cn(
    orientation === "horizontal" ? "min-h-14 justify-between py-1 has-[>[data-slot=field-content]]:items-center" : "gap-2 py-3",
    className,
  )} {...props} />;
}

export function SettingsHelp({ title, children }: { title: string; children: ReactNode }) {
  return <details className="group text-xs text-muted-foreground">
    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />
      {title}
    </summary>
    <div className="flex flex-col gap-2 pb-2 pl-6">{children}</div>
  </details>;
}
