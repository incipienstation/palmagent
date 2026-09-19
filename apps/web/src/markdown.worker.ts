import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { markdownUrlTransform } from "./image-source";
import type { Root, RootContent } from "hast";

// Parse the whole document so late reference definitions, fences, tables, and
// footnotes keep their normal Markdown meaning. Only the CPU work moves off-thread.
const processor = unified().use(remarkParse).use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true });
function clean(node: Root | RootContent): Root | RootContent {
  if (node.type === "raw") return { type: "text", value: node.value };
  if (node.type === "element") {
    // These are the only URL properties produced by our Markdown pipeline.
    for (const key of ["href", "src"]) {
      if (key in node.properties) node.properties[key] = markdownUrlTransform(String(node.properties[key] ?? ""), key);
    }
  }
  delete node.position;
  if ("children" in node) node.children = node.children.map(child => clean(child) as RootContent) as typeof node.children;
  return node;
}
onmessage = ({ data }: MessageEvent<{ id: number; text: string }>) => {
  try {
    const tree = clean(processor.runSync(processor.parse(data.text)) as Root) as Root;
    // Strings let the UI compare blocks without reparsing unchanged subtrees.
    postMessage({ id: data.id, blocks: tree.children.map(node => JSON.stringify(node)) });
  } catch {
    postMessage({ id: data.id, blocks: null });
  }
};
