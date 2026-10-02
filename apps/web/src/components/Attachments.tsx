import { INPUT_IMAGE_POLICY } from "@palmagent/shared";
import { useActionState } from "../action-state";
import { beginBrowserWork } from "../update-state";
import { useCallback, useRef, type ClipboardEvent } from "react";
import type { InputAttachment } from "@palmagent/shared";
import { Camera, ImagePlus, Loader2, Plus, X, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import {
  attachmentPreviewUrl,
  attachmentsWireSize,
  fileToAttachment,
  imageFilesFromClipboard,
  MAX_ATTACHMENTS,
} from "../images";
import { VideoPreview } from "./VideoPreview";

// Leave room for the prompt and JSON envelope before the shared upload cap.
const WIRE_WARN_BYTES = INPUT_IMAGE_POLICY.maxWireBytes * 0.9;

// Shared image-attachment state for a compose box: paste handler (the main
// path — screenshots land on the clipboard), file picker fallback, previews.
export function useImageAttachments(onError: (msg: string) => void, key = `images:${location.hash}`) {
  const [images, setImages] = useActionState<InputAttachment[]>(key, []);
  const [preparing, setPreparing] = useActionState(`${key}:preparing`, false);

  const addFiles = useCallback(
    async (files: File[]) => {
      const finish = beginBrowserWork();
      setPreparing(true);
      try {
        const prepared: InputAttachment[] = [];
        for (const f of files) prepared.push(await fileToAttachment(f));
        setImages((cur) => {
          const next = [...cur, ...prepared];
          if (next.length > MAX_ATTACHMENTS) {
            onError(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
            return cur;
          }
          if (attachmentsWireSize(next) > INPUT_IMAGE_POLICY.maxWireBytes - 100_000) {
            onError("Attachments exceed the upload limit. Remove or trim a video, then retry.");
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
    [onError, setImages, setPreparing],
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

  const remove = useCallback((i: number) => setImages((cur) => cur.filter((_, j) => j !== i)), [setImages]);
  const clear = useCallback(() => setImages([]), [setImages]);

  return { images, preparing, addFiles, onPaste, remove, clear, setImages };
}

export function AttachmentMenu({ open, onOpenChange, disabled, preparing, onAdd, voiceActive, onCancelVoice }: {
  open: boolean; onOpenChange: (open: boolean) => void; disabled?: boolean; preparing?: boolean;
  onAdd: (files: File[]) => void;
  voiceActive?: boolean; onCancelVoice?: () => void;
}) {
  const photos = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const videos = useRef<HTMLInputElement>(null);
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length) onAdd(files);
  };
  return <>
    <DropdownMenu open={open && !voiceActive} onOpenChange={next => onOpenChange(voiceActive ? false : next)}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-lg" className="shrink-0"
          aria-label={voiceActive ? "Cancel voice input" : preparing ? "Preparing attachments" : "Add attachments"}
          title={voiceActive ? "Cancel voice input" : preparing ? "Preparing attachments" : "Add attachments"}
          aria-haspopup={voiceActive ? undefined : "menu"} aria-expanded={voiceActive ? undefined : open}
          disabled={!voiceActive && disabled}
          onClick={() => { if (voiceActive) onCancelVoice?.(); }}>
          <span className={cn("inline-flex transition-transform duration-200 motion-reduce:transition-none", voiceActive && "rotate-45")}>
            {preparing && !voiceActive ? <Loader2 className="animate-spin" /> : <Plus />}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" collisionPadding={12} className="w-56 max-w-[calc(100vw-24px)] rounded-3xl p-2"><DropdownMenuGroup>
        <DropdownMenuItem size="lg" onSelect={() => camera.current?.click()}>
          <Camera /> Camera
        </DropdownMenuItem>
        <DropdownMenuItem size="lg" onSelect={() => photos.current?.click()}>
          <ImagePlus /> Photos
        </DropdownMenuItem>
        <DropdownMenuItem size="lg" onSelect={() => videos.current?.click()}>
          <Video /> Videos
        </DropdownMenuItem>
      </DropdownMenuGroup></DropdownMenuContent>
    </DropdownMenu>
    <input ref={photos} aria-label="Attach photos" type="file" accept="image/*" multiple hidden disabled={disabled} onChange={pick} />
    <input ref={videos} aria-label="Attach videos" type="file" accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov" multiple hidden disabled={disabled} onChange={pick} />
    <input ref={camera} aria-label="Take a photo" type="file" accept="image/*" capture="environment" hidden disabled={disabled} onChange={pick} />
  </>;
}

export function AttachmentTray({ images, disabled, onRemove }: {
  images: InputAttachment[]; disabled?: boolean; onRemove: (i: number) => void;
}) {
  return <div className="min-w-0 w-full">
    <div className="flex gap-2 overflow-x-auto py-1">
      {images.map((img, i) => <span className="relative inline-flex shrink-0 pr-2 pt-2" key={i}>
        {img.video ? <VideoPreview src={attachmentPreviewUrl(img)} poster={attachmentPreviewUrl(img.video.frames[0].image)} label={`attachment ${i + 1}`} compact />
          : <img className="size-16 rounded-xl border border-input object-cover" src={attachmentPreviewUrl(img)} alt={`attachment ${i + 1}`} />}
        <Button type="button" variant="secondary" size="icon-sm" className="absolute top-0 right-0"
          aria-label={`Remove ${img.video ? "video" : "image"} ${i + 1}`} disabled={disabled} onClick={() => onRemove(i)}><X /></Button>
      </span>)}
    </div>
    {images.some(image => image.video) && <p className="py-1 text-xs text-muted-foreground">Agents receive sampled frames. Audio is not included.</p>}
    {attachmentsWireSize(images) > WIRE_WARN_BYTES && <p className="py-1 text-xs text-amber">Large attachments are close to the upload limit.</p>}
  </div>;
}
