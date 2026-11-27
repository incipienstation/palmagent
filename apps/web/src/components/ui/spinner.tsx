import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle aria-hidden="true" className={cn("inline-block size-4 shrink-0 align-text-bottom motion-safe:animate-spin", className)} />;
}

export function Pending({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-1.5"><Spinner className="size-[1em]" />{children}</span>;
}
