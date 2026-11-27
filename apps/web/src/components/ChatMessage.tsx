import { useContext, type ReactNode } from "react";
import { attachmentUrl, type Attachment, type InputAttachment } from "@palmagent/shared";
import { cn } from "@/lib/utils";
import { attachmentPreviewUrl } from "../images";
import { FileAttachment } from "./FileAttachment";
import { SkillChips } from "./SkillPicker";
import { Message, MessageContent, MessageHeader } from "./ui/message";
import { Bubble, BubbleContent } from "./ui/bubble";
import { Markdown } from "./Markdown";
import { VideoPreview } from "./VideoPreview";
import { ImagePreview, ImageTaskContext } from "./ImagePreview";

export function UserBubble({ text, imageOnly, meta, skills, attachments, images, onImageLoad }: {
  text: string; imageOnly?: boolean; meta?: string; skills?: import("@palmagent/shared").SkillSelection[]; attachments?: Attachment[]; images?: InputAttachment[]; onImageLoad?: () => void;
}) {
  const taskId = useContext(ImageTaskContext);
  const items = attachments?.length ? (taskId ? attachments : []) : images ?? [];
  const photosOnly = items.length > 0 && items.every(item => !item.file && !item.video);
  const tiled = photosOnly && items.length > 1;
  const landscapePair = items.length === 2 && items.every(item => item.width && item.height && item.width > item.height);
  const caption = photosOnly && imageOnly ? "" : text;
  const previews = items.map((item, index) => {
    const stored = "id" in item;
    const key = stored ? `${item.id}-${index}` : index;
    if (item.file) return <FileAttachment key={key} name={item.file.name}
      size={stored ? item.size : undefined} href={stored && taskId ? attachmentUrl(taskId, item.id) : undefined} />;
    const src = stored ? attachmentUrl(taskId!, item.id) : attachmentPreviewUrl(item);
    if (item.video) {
      const poster = stored ? attachmentUrl(taskId!, item.video.frames[0].id) : attachmentPreviewUrl(item.video.frames[0].image);
      return <VideoPreview key={key} src={src} poster={poster} label={`Attached video ${index + 1}`} onLoad={onImageLoad} />;
    }
    return <ImagePreview key={key} src={src} alt={`Attached image ${index + 1}`} width={item.width} height={item.height}
      layout={tiled ? "tile" : photosOnly ? "single" : "inline"} onLoad={onImageLoad} />;
  });
  return (
    <Message align="end" role="group" aria-label="Your message" className="mb-3">
      <MessageContent className={photosOnly ? "gap-1.5" : undefined}>
        {meta && (
          <MessageHeader>
            <span className="rounded bg-muted px-1.5 py-px font-sans text-[10px] tracking-normal normal-case text-faint">
              {meta}
            </span>
          </MessageHeader>
        )}
        {photosOnly && <div className={cn("self-end", tiled
          ? ["grid w-full max-w-lg gap-1.5", items.length === 3 ? "grid-cols-3" : "grid-cols-2"]
          : "flex w-full max-w-[min(88%,32rem)] justify-end", landscapePair && "[&>button]:aspect-video")}>
          {previews}
        </div>}
        {(caption || skills?.length || (!photosOnly && items.length > 0)) ? (
          <Bubble align="end" variant="secondary" className="max-w-[88%]">
            <BubbleContent className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              <SkillChips skills={skills} />
              {caption}
              {!photosOnly && items.length > 0 && <div className="flex flex-wrap gap-2">{previews}</div>}
            </BubbleContent>
          </Bubble>
        ) : null}
      </MessageContent>
    </Message>
  );
}

export function AssistantMessage({ text, streaming, children }: { text: string; streaming?: boolean; children?: ReactNode }) {
  return <Message className="mb-4">
    <MessageContent>
      <Markdown streaming={streaming} caret>{text}</Markdown>
      {children}
    </MessageContent>
  </Message>;
}
