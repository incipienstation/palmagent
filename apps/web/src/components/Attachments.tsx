import { useCallback, useRef, useState, type ClipboardEvent } from "react";
import type { ImageAttachment } from "@palmagent/shared";
import { ImagePlus, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
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
export function useImageAttachments(onError: (msg: string) => void) {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [preparing, setPreparing] = useState(false);

  const addFiles = useCallback(
    async (files: File[]) => {
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

  return { images, preparing, addFiles, onPaste, remove, clear };
}

export function AttachmentTray({
  images,
  disabled,
  preparing,
  onAdd,
  onRemove,
}: {
  images: ImageAttachment[];
  disabled?: boolean;
  preparing?: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (i: number) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const oversize = attachmentsWireSize(images) > WIRE_WARN_BYTES;
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        {images.map((img, i) => (
          <span className="relative inline-flex" key={i}>
            <img
              className="size-14 rounded-lg border border-input object-cover"
              src={attachmentPreviewUrl(img)}
              alt={`attachment ${i + 1}`}
            />
            <button
              type="button"
              className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-input bg-accent text-foreground"
              aria-label={`Remove image ${i + 1}`}
              onClick={() => onRemove(i)}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-dashed font-normal text-muted-foreground"
          disabled={disabled || preparing}
          onClick={() => fileRef.current?.click()}
        >
          {preparing ? <Loader2 className="animate-spin" /> : <ImagePlus />}
          image
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = ""; // re-selecting the same file must fire again
            if (files.length) onAdd(files);
          }}
        />
      </div>
      {oversize && (
        <div className="mt-1.5 text-xs text-amber">
          Large attachments may be rejected by the proxy's upload limit.
        </div>
      )}
    </div>
  );
}
