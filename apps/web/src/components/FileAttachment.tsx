import { Download, FileText } from "lucide-react";
import { Button } from "./ui/button";

export function FileAttachment({ name, size, href }: { name: string; size?: number; href?: string }) {
  const content = <><FileText aria-hidden data-icon="inline-start" className="shrink-0" />
    <span className="min-w-0 truncate" title={name}>{name}</span>
    {size !== undefined && <span className="shrink-0 text-xs text-muted-foreground">{size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 / 1024).toFixed(1)} MiB`}</span>}
  </>;
  return href ? <Button asChild variant="outline" className="max-w-full">
    <a href={href} download={name} aria-label={`Download ${name}`}>{content}<Download data-icon="inline-end" /></a>
  </Button> : <span className="inline-flex h-16 max-w-60 items-center gap-2 rounded-xl border border-input px-3 text-sm">{content}</span>;
}
