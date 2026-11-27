import { Spinner } from "@/components/ui/spinner";
import { useContext, useState } from "react";
import { Maximize } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { ImageTaskContext } from "./ImagePreview";

function VisualizationFrame({ src, name, preview = false }: { src: string; name: string; preview?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  return <div className={preview ? "relative h-64" : "relative min-h-0 flex-1"}>
    {!loaded && <span role="status" aria-label="Loading visualization" className="pointer-events-none absolute inset-0 grid place-items-center text-muted-foreground"><Spinner /></span>}
    <iframe src={src} title={name} sandbox="allow-scripts" referrerPolicy="no-referrer"
      loading={preview ? "lazy" : undefined} inert={preview} tabIndex={preview ? -1 : undefined}
      onLoad={() => setLoaded(true)} className={preview ? "pointer-events-none block size-full" : "block size-full"} />
  </div>;
}

export function VisualizationPreview({ path }: { path: string }) {
  const taskId = useContext(ImageTaskContext);
  if (!taskId) return <p role="status">Visualization unavailable for this task.</p>;
  const src = `/api/tasks/${encodeURIComponent(taskId)}/visualization?${new URLSearchParams({ path })}`;
  const name = path.split("/").at(-1) || "Visualization";
  return <Dialog>
    <div className="relative my-2 overflow-hidden rounded-md border border-border">
      <VisualizationFrame key={src} src={src} name={name} preview />
      <DialogTrigger asChild>
        <Button type="button" variant="floating" size="icon-lg" aria-label={`Open visualization: ${name}`}
          className="absolute top-1 right-1"><Maximize /></Button>
      </DialogTrigger>
    </div>
    <DialogContent aria-describedby={undefined} className="h-[calc(var(--app-height,100dvh)-2rem)] max-w-4xl">
      <DialogHeader><DialogTitle className="truncate">{name}</DialogTitle></DialogHeader>
      <VisualizationFrame key={src} src={src} name={name} />
    </DialogContent>
  </Dialog>;
}
