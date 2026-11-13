import { useContext, type ReactNode } from "react";
import { attachmentUrl, type Attachment, type InputAttachment } from "@palmagent/shared";
import { FileAttachment } from "./FileAttachment";
import { SkillChips } from "./SkillPicker";
import { Message, MessageContent, MessageHeader } from "./ui/message";
import { Bubble, BubbleContent } from "./ui/bubble";
import { Markdown } from "./Markdown";
import { VideoPreview } from "./VideoPreview";
import { ImagePreview, ImageTaskContext } from "./ImagePreview";

export function UserBubble({ text, meta, skills, attachments, images, onImageLoad }: {
  text: string; meta?: string; skills?: import("@palmagent/shared").SkillSelection[]; attachments?: Attachment[]; images?: InputAttachment[]; onImageLoad?: () => void;
}) {
  const taskId = useContext(ImageTaskContext);
  // Right-aligned soft chat bubble — the human side of the transcript.
  return (
    <Message align="end" role="group" aria-label="Your message" className="mb-3">
      <MessageContent>
        {meta && (
          <MessageHeader>
            <span className="rounded bg-muted px-1.5 py-px font-sans text-[10px] tracking-normal normal-case text-faint">
              {meta}
            </span>
          </MessageHeader>
        )}
        <Bubble align="end" variant="secondary" className="max-w-[88%]">
          <BubbleContent className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            <SkillChips skills={skills} />
            {text}
            {!attachments?.length && !!images?.length && <div className="flex flex-wrap gap-2">
              {images.map((image, index) => image.file ? <FileAttachment key={index} name={image.file.name} /> : image.video ? <VideoPreview key={index} src={`data:${image.mediaType};base64,${image.data}`}
                poster={`data:${image.video.frames[0].image.mediaType};base64,${image.video.frames[0].image.data}`} label={`Attached video ${index + 1}`} onLoad={onImageLoad} /> : <ImagePreview key={index} src={`data:${image.mediaType};base64,${image.data}`}
                alt={`Attached image ${index + 1}`} width={image.width} height={image.height} onLoad={onImageLoad} />)}
            </div>}
            {taskId && !!attachments?.length && <div className="flex flex-wrap gap-2">
              {attachments.map((attachment, index) => attachment.file ? <FileAttachment key={`${attachment.id}-${index}`} name={attachment.file.name} size={attachment.size} href={attachmentUrl(taskId, attachment.id)} /> : attachment.video ? <VideoPreview key={`${attachment.id}-${index}`}
                src={attachmentUrl(taskId, attachment.id)} poster={attachmentUrl(taskId, attachment.video.frames[0].id)} label={`Attached video ${index + 1}`} onLoad={onImageLoad} /> : <ImagePreview key={`${attachment.id}-${index}`}
                src={attachmentUrl(taskId, attachment.id)} alt={`Attached image ${index + 1}`}
                width={attachment.width} height={attachment.height} onLoad={onImageLoad} />)}
            </div>}
          </BubbleContent>
        </Bubble>
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
