import { beginBrowserWork, useUpdateState } from "../update-state";
import { useCallback, useRef, useState, type ClipboardEvent } from "react";
import type { ImageAttachment } from "@palmagent/shared";
import { Camera, ImagePlus, Loader2, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import {
  attachmentPreviewUrl,
  attachmentsWireSize,
  fileToAttachment,
  imageFilesFromClipboard,
  MAX_ATTACHMENTS,
} from "../images";

// Default nginx client_max_body_size is 1m; warn before the proxy 413s.
const WIRE_WARN_BYTES = 900_000;

// Shared image-attachment state for a compose box: paste handler (the main
// path — screenshots land on the clipboard), file picker fallback, previews.
export function useImageAttachments(onError: (msg: string) => void, key = `images:${location.hash}`) {
  const [images, setImages] = useUpdateState<ImageAttachment[]>(key, []);
  const [preparing, setPreparing] = useState(false);

  const addFiles = useCallback(
    async (files: File[]) => {
      const finish = beginBrowserWork();
      setPreparing(true);
      try {
        const prepared: ImageAttachment[] = [];
        for (const f of files) prepared.push(await fileToAttachment(f));
        setImages((cur) => {
          const next = [...cur, ...prepared];
          if (next.length > MAX_ATTACHMENTS) {
            onError(`Up to ${MAX_ATTACHMENTS} images per message.`);
            return cur;
          }
          return next;
        });
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      } finally {
        setPreparing(false);
        finish();
      }
    },
    [onError],
  );

  // Attach pasted images; plain text pastes fall through untouched.
  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLElement>) => {
      const files = imageFilesFromClipboard(e.clipboardData);
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles],
  );

  const remove = useCallback((i: number) => setImages((cur) => cur.filter((_, j) => j !== i)), []);
  const clear = useCallback(() => setImages([]), []);

  return { images, preparing, addFiles, onPaste, remove, clear, setImages };
}

export function AttachmentMenu({ open, onOpenChange, disabled, preparing, onAdd }: {
  open: boolean; onOpenChange: (open: boolean) => void; disabled?: boolean; preparing?: boolean;
  onAdd: (files: File[]) => void;
}) {
  const photos = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length) onAdd(files);
  };
  return <>
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-lg" className="shrink-0"
          aria-label={preparing ? "Preparing images" : "Add attachments"} disabled={disabled}>
          {preparing ? <Loader2 className="animate-spin" /> : <Plus />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" collisionPadding={12} className="w-56 max-w-[calc(100vw-24px)] rounded-3xl p-2"><DropdownMenuGroup>
        <DropdownMenuItem size="lg" onSelect={() => camera.current?.click()}>
          <Camera /> Camera
        </DropdownMenuItem>
        <DropdownMenuItem size="lg" onSelect={() => photos.current?.click()}>
          <ImagePlus /> Photos
        </DropdownMenuItem>
      </DropdownMenuGroup></DropdownMenuContent>
    </DropdownMenu>
    <input ref={photos} aria-label="Attach photos" type="file" accept="image/*" multiple hidden disabled={disabled} onChange={pick} />
    <input ref={camera} aria-label="Take a photo" type="file" accept="image/*" capture="environment" hidden disabled={disabled} onChange={pick} />
  </>;
}

export function AttachmentTray({ images, disabled, onRemove }: {
  images: ImageAttachment[]; disabled?: boolean; onRemove: (i: number) => void;
}) {
  return <div className="min-w-0 w-full">
    <div className="flex gap-2 overflow-x-auto py-1">
      {images.map((img, i) => <span className="relative inline-flex shrink-0 pr-2 pt-2" key={i}>
        <img className="size-16 rounded-xl border border-input object-cover" src={attachmentPreviewUrl(img)} alt={`attachment ${i + 1}`} />
        <Button type="button" variant="secondary" size="icon-lg" className="absolute top-0 right-0"
          aria-label={`Remove image ${i + 1}`} disabled={disabled} onClick={() => onRemove(i)}><X /></Button>
      </span>)}
    </div>
    {attachmentsWireSize(images) > WIRE_WARN_BYTES && <p className="py-1 text-xs text-amber">Large attachments may be rejected by the proxy's upload limit.</p>}
  </div>;
}
