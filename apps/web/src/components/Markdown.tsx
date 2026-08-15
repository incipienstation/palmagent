import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

// Element → token-styled renderer for assistant prose — the one place we parse
// markdown (GFM: headings/bold/lists/code/tables). We do NOT enable raw HTML:
// react-markdown escapes it by default, so `<Chart>`/`List<T>` show literally
// and a stray `<script>` can never run — XSS-safe with no sanitizer. Every color
// is a design token (text-strong/-blue, bg-muted, border-border) so light + dark
// both Just Work, matching the surrounding event log. Defined at module scope so
// the object identity is stable across renders (keeps the memo below effective).
const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-[17px] font-semibold text-strong">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-[16px] font-semibold text-strong">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2.5 mb-1 text-[15px] font-semibold text-strong">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-2.5 mb-1 text-[14px] font-semibold text-strong">{children}</h4>,
  h5: ({ children }) => <h5 className="mt-2 mb-1 text-[13px] font-semibold text-strong">{children}</h5>,
  h6: ({ children }) => <h6 className="mt-2 mb-1 text-[13px] font-semibold text-faint">{children}</h6>,
  p: ({ children }) => <p className="my-2 leading-[22px]">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-strong">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue underline underline-offset-2 [overflow-wrap:anywhere]"
    >
      {children}
    </a>
  ),
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
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-[12.5px] leading-[18px] text-strong [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  // GFM table: wrap in an overflow-x-auto rail so a wide table scrolls *inside*
  // the pane on a phone, never widening the document (the mobile overflow
  // contract the e2e harness asserts).
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold text-strong">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
};

// Render assistant markdown. `memo` skips re-parsing when the text is unchanged
// (the log re-renders on every streamed delta of OTHER items too). First/last
// child margins are collapsed so the block aligns flush in the event log.
//
// `trailing` is the streaming caret. It must sit INSIDE this wrapper (not as a
// sibling of it) and trail the prose: react-markdown emits the final block as a
// block-level `<p>`, so we inline that last paragraph (`p:nth-last-child(2)` — the
// caret is the actual last child) and the caret flows on the same line, the way
// the old plain-text caret did. A non-paragraph final block (table/list mid-stream)
// stays block and the caret drops below it — an acceptable transient.
export const Markdown = memo(function Markdown({
  children,
  trailing,
}: {
  children: string;
  trailing?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        trailing && "[&>p:nth-last-child(2)]:mb-0 [&>p:nth-last-child(2)]:inline",
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
      {trailing}
    </div>
  );
});
