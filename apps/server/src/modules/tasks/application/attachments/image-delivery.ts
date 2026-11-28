import { DELIVERED_IMAGE_PATTERN, DELIVERED_IMAGE_PREFIX, type AgentEvent } from "@palmagent/shared";

/** Claim explicit delivery links from provider tool output or streamed assistant Markdown. */
export class ImageDeliveryReceipts {
  private readonly tails = new Map<string, { messageId?: string; text: string }>();

  from(event: AgentEvent): Set<string> {
    const found = new Set<string>();
    const scan = (text: string) => {
      if (!text.includes(DELIVERED_IMAGE_PREFIX)) return;
      for (const match of text.matchAll(new RegExp(DELIVERED_IMAGE_PATTERN, "g"))) {
        found.add(match[1]);
        if (found.size >= 8) break;
      }
    };
    if (event.kind === "assistant_text") {
      const { messageId, text } = event.payload;
      const tail = this.tails.get(event.taskId);
      const chunk = (tail && tail.messageId === messageId ? tail.text : "") + text;
      scan(chunk);
      // A link may be split across any two deltas, including the path prefix.
      const suffix = chunk.slice(-(DELIVERED_IMAGE_PREFIX.length + 36 + 5));
      if (suffix.includes("/")) this.tails.set(event.taskId, { messageId, text: suffix });
      else this.tails.delete(event.taskId);
    } else if (event.kind === "result") this.tails.delete(event.taskId);
    else if (event.kind === "tool_result") {
      let visited = 0;
      function visit(value: unknown, depth: number): void {
        if (++visited > 2000 || depth > 12 || found.size >= 8) return;
        if (typeof value === "string") scan(value);
        else if (value && typeof value === "object") {
          for (const item of Object.values(value)) {
            visit(item, depth + 1);
            if (visited >= 2000 || found.size >= 8) break;
          }
        }
      }
      visit(event.payload, 0);
    }
    return found;
  }
}
