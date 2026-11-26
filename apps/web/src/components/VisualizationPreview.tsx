import { useContext } from "react";
import { Maximize } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { ImageTaskContext } from "./ImagePreview";

export function VisualizationPreview({ path }: { path: string }) {
  const taskId = useContext(ImageTaskContext);
  if (!taskId) return <p role="status">Visualization unavailable for this task.</p>;
  const src = `/api/tasks/${encodeURIComponent(taskId)}/visualization?${new URLSearchParams({ path })}`;
  const name = path.split("/").at(-1) || "Visualization";
  return <Dialog>
    <div className="relative my-2 overflow-hidden rounded-md border border-border">
      <iframe src={src} title={name} sandbox="allow-scripts" referrerPolicy="no-referrer"
        loading="lazy" inert tabIndex={-1} className="pointer-events-none block h-64 w-full" />
      <DialogTrigger asChild>
        <Button type="button" variant="floating" size="icon-lg" aria-label={`Open visualization: ${name}`}
          className="absolute top-1 right-1"><Maximize /></Button>
      </DialogTrigger>
    </div>
    <DialogContent aria-describedby={undefined} className="h-[calc(var(--app-height,100dvh)-2rem)] max-w-4xl">
      <DialogHeader><DialogTitle className="truncate">{name}</DialogTitle></DialogHeader>
      <iframe src={src} title={name} sandbox="allow-scripts" referrerPolicy="no-referrer" className="min-h-0 w-full flex-1" />
    </DialogContent>
  </Dialog>;
}
