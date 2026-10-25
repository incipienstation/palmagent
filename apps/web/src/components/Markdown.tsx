import { ScrollArea } from "./ui/scroll-area";
import { memo, useContext, type ReactNode } from "react";
import { Streamdown, type Components, type ExtraProps } from "streamdown";
import remarkGfm from "remark-gfm";
import { isLocalImageLink, markdownUrlTransform, previewSource } from "../image-source";
import { ImageLinkContext, ImagePreview, ImageTaskContext } from "./ImagePreview";
import { MermaidBlock } from "./MermaidBlock";
import { CodeBlock } from "./CodeBlock";

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode } & ExtraProps) {
  const taskId = useContext(ImageTaskContext);
  const target = href && taskId && isLocalImageLink(href) ? previewSource(href, taskId) : href;
  return <ImageLinkContext.Provider value={true}>
    <a href={target} target="_blank" rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 [overflow-wrap:anywhere]">{children}</a>
  </ImageLinkContext.Provider>;
}

// Element → token-styled renderer for assistant prose — the one place we parse
// markdown (GFM: headings/bold/lists/code/tables). We do NOT enable raw HTML:
// Disable Streamdown’s default raw-HTML plugins so `<Chart>`/`List<T>` show literally
// and a stray `<script>` can never run — XSS-safe with no sanitizer. Every color
// is a design token (text-strong/-primary, bg-muted, border-border) so light + dark
// both Just Work, matching the surrounding event log. Defined at module scope so
// the object identity is stable across renders (keeps the memo below effective).
const COMPONENTS = {
  img: ({ src, alt, title }) => <ImagePreview src={src} alt={alt} title={title} />,
  h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-[17px] font-semibold text-strong">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-[16px] font-semibold text-strong">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2.5 mb-1 text-[15px] font-semibold text-strong">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-2.5 mb-1 text-[14px] font-semibold text-strong">{children}</h4>,
  h5: ({ children }) => <h5 className="mt-2 mb-1 text-[13px] font-semibold text-strong">{children}</h5>,
  h6: ({ children }) => <h6 className="mt-2 mb-1 text-[13px] font-semibold text-faint">{children}</h6>,
  p: ({ children }) => <p className="my-2 leading-[22px]">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-strong">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: MarkdownLink,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-[21px] [&>ul]:mt-1 [&>ol]:mt-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  // Inline code: a quiet pill. Block code is handled by `pre`, which strips this
  // pill chrome off its child `<code>` so a fenced block reads as one slab.
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12.5px] text-strong [overflow-wrap:anywhere]">
      {children}
    </code>
  ),
  pre: ({ children, node }) => {
    const code = node?.children[0];
    if (code?.type === "element" && code.tagName === "code") {
      const source = code.children.map(child => child.type === "text" ? child.value : "").join("");
      const language = Array.isArray(code.properties.className)
        ? code.properties.className.find(value => typeof value === "string" && value.startsWith("language-"))?.toString().slice(9) : undefined;
      if (language === "mermaid") return <MermaidBlock source={source} />;
      const meta = typeof code.data?.meta === "string" ? code.data.meta : "";
      const filename = /(?:^|\s)(?:title|filename)="([^"]+)"/.exec(meta)?.[1];
      return <CodeBlock source={source} language={language} filename={filename} />;
    }
    return <ScrollArea orientation="horizontal" className="my-2 rounded-md bg-muted" contentClassName="w-max min-w-full" viewportProps={{ tabIndex: 0, "aria-label": "Code" }}><pre className="rounded-md bg-muted p-3 font-mono text-[12.5px] leading-[18px] text-strong [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre></ScrollArea>;
  },
  // GFM table: use the shared horizontal scroll area so a wide table scrolls *inside*
  // the pane on a phone, never widening the document (the mobile overflow
  // contract the e2e harness asserts).
  table: ({ children }) => (
    <ScrollArea orientation="horizontal" className="my-2" viewportProps={{ tabIndex: 0, "aria-label": "Table" }}>
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </ScrollArea>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold text-strong">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
} satisfies Components;

// Stable plugin lists keep completed streaming blocks memoized. Raw HTML remains
// literal text and all URLs still pass through Palmagent's protocol policy.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS: [] = [];

export const Markdown = memo(function Markdown({ children, streaming = false, caret = false }: {
  children: string; streaming?: boolean; caret?: boolean;
}) {
  return <Streamdown
    mode={streaming ? "streaming" : "static"}
    isAnimating={streaming}
    parseIncompleteMarkdown={streaming}
    caret={caret && streaming ? "block" : undefined}
    remarkPlugins={REMARK_PLUGINS}
    rehypePlugins={REHYPE_PLUGINS}
    urlTransform={markdownUrlTransform}
    components={COMPONENTS}
    controls={false}
    className="min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
  >{children}</Streamdown>;
});
