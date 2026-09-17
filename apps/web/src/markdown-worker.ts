// One worker per page, with at most one parse in flight and one pending value
// per mounted message. A token burst cannot build an unbounded worker queue.
type Listener = (blocks: string[] | null) => void;
type Job = { id: number; text: string; revision: number };
type Client = { listener: Listener; text: string; revision: number; published: number };
let worker: Worker | undefined;
let failed = false;
let nextId = 0;
let active: Job | undefined;
const clients = new Map<number, Client>();
const pending = new Map<number, Job>();
// Bounded page-local cache avoids re-parsing when virtual rows remount.
const cache = new Map<string, string[]>();
let cacheSize = 0;
export const cachedMarkdown = (text: string) => cache.get(text);
function pump() {
  if (active || !pending.size || failed) return;
  active = pending.values().next().value!;
  pending.delete(active.id);
  worker!.postMessage(active);
}
function fail() {
  failed = true; active = undefined; pending.clear();
  worker?.terminate(); worker = undefined;
  for (const { listener } of clients.values()) listener(null);
}
export function markdownParser(listener: Listener) {
  const id = ++nextId;
  const client: Client = { listener, text: "", revision: 0, published: 0 };
  clients.set(id, client);
  if (!worker && !failed) {
    try {
      worker = new Worker(new URL("./markdown.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }: MessageEvent<{ id: number; blocks: string[] | null }>) => {
        const job = active!;
        active = undefined;
        if (data.blocks && !cache.has(job.text)) {
          cache.set(job.text, data.blocks);
          cacheSize += job.text.length + data.blocks.join("").length;
          while (cacheSize > 2_000_000 && cache.size) {
            const [text, blocks] = cache.entries().next().value!;
            cacheSize -= text.length + blocks.join("").length;
            cache.delete(text);
          }
        }
        const target = clients.get(data.id);
        // Progressive results are useful during appends, but must never replace
        // a newer cache hit or text that was rewritten rather than appended.
        if (target && job.revision >= target.published && target.text.startsWith(job.text)) {
          target.published = job.revision;
          target.listener(data.blocks);
        }
        pump();
      };
      worker.onerror = fail;
      worker.onmessageerror = fail;
    } catch { fail(); }
  }
  return {
    parse(text: string) {
      client.text = text; client.revision++;
      const cached = cache.get(text);
      if (cached) {
        pending.delete(id); client.published = client.revision; listener(cached); return;
      }
      if (failed) { listener(null); return; }
      pending.set(id, { id, text, revision: client.revision }); pump();
    },
    dispose() { clients.delete(id); pending.delete(id); },
  };
}
