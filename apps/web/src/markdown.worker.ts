import { parseMarkdown } from "./markdown-parse";

onmessage = ({ data }: MessageEvent<{ id: number; text: string }>) => {
  postMessage({ id: data.id, blocks: parseMarkdown(data.text) });
};
