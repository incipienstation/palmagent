import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { markdownUrlTransform } from "./image-source";
import type { Root, RootContent } from "hast";

const processor = unified().use(remarkParse).use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true });
function clean(node: Root | RootContent): Root | RootContent {
  if (node.type === "raw") return { type: "text", value: node.value };
  if (node.type === "element") {
    for (const key of ["href", "src"]) {
      if (key in node.properties) node.properties[key] = markdownUrlTransform(String(node.properties[key] ?? ""), key);
    }
  }
  delete node.position;
  if ("children" in node) node.children = node.children.map(child => clean(child) as RootContent) as typeof node.children;
  return node;
}

// Use the same whole-document parser for worker updates and cold history rows.
// Late reference definitions, fences, tables, and footnotes retain their meaning.
export function parseMarkdown(text: string): string[] | null {
  try {
    const tree = clean(processor.runSync(processor.parse(text)) as Root) as Root;
    return tree.children.map(node => JSON.stringify(node));
  } catch {
    return null;
  }
}
