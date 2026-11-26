import type { Element, Root } from "hast";

const prefix = "\ue200visualize\ue202";
const end = "\ue201";

// Read the original JSON, before Markdown interprets escapes or markup in filenames.
// Only a standalone prose paragraph can become a preview. Code examples stay literal.
export function visualizeMarkers() {
  return (tree: Root, file: { value: string | Uint8Array }) => {
    const source = file.value;
    if (typeof source !== "string" || !source.includes(prefix)) return;
    const visit = (parent: Root | Element) => {
      for (const node of parent.children) {
        if (node.type !== "element") continue;
        if (node.tagName !== "p") {
          visit(node);
          continue;
        }
        const start = node.position?.start.offset;
        const stop = node.position?.end.offset;
        if (start === undefined || stop === undefined) continue;
        const marker = source.slice(start, stop);
        if (!marker.startsWith(prefix) || !marker.endsWith(end)) continue;
        try {
          const path: unknown = JSON.parse(marker.slice(prefix.length, -end.length))?.path;
          if (typeof path === "string" && path) node.properties.visualizePath = path;
        } catch { /* A malformed marker is ordinary text. */ }
      }
    };
    visit(tree);
  };
}
