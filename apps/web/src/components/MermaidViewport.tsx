import { useState } from "react";
import { Maximize } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogTrigger } from "./ui/dialog";
import { ImageViewerContent } from "./ImageViewerContent";

export default function MermaidViewport({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={setOpen}>
    <div role="region" aria-label="Mermaid diagram" onDoubleClick={() => setOpen(true)}
      className="relative flex h-full touch-manipulation items-center justify-center overflow-hidden p-3">
      <img src={url} alt="Mermaid diagram" draggable={false} className="max-h-full max-w-full select-none object-contain" />
      <DialogTrigger asChild>
        <Button type="button" variant="secondary" size="icon-lg" className="absolute top-1 right-1"
          aria-label="Open diagram fullscreen" title="Open diagram fullscreen"><Maximize /></Button>
      </DialogTrigger>
    </div>
    <ImageViewerContent src={url} label="Mermaid diagram" kind="diagram" />
  </Dialog>;
}
