import { test, expect } from "@playwright/test";
import { createMermaidCache, MERMAID_CACHE_LIMITS } from "../../src/mermaid-cache";

const signal = () => new AbortController().signal;
function gate<T>() { let release!: (value: T) => void; const promise = new Promise<T>(resolve => { release = resolve; }); return { promise, release }; }

test("identical diagrams share rendering; aborting one reader preserves the other", async () => {
  const result = gate<string>();
  let calls = 0;
  const cache = createMermaidCache(async () => { calls++; return result.promise; });
  const leaving = new AbortController();
  const first = cache.render("diagram", "dark", leaving.signal);
  const second = cache.render("diagram", "dark", signal());
  expect(first).toBe(second);
  await expect.poll(() => calls).toBe(1);
  leaving.abort();
  result.release("svg");
  expect(await second).toBe("svg");
  expect(cache.get("diagram", "dark")).toBe("svg");
  expect(await cache.render("diagram", "dark", signal())).toBe("svg");
  expect(calls).toBe(1);
});

test("cancelled queued diagrams do not render and an abandoned active render does not cache", async () => {
  const result = gate<string>();
  const calls: string[] = [];
  const cache = createMermaidCache(async source => { calls.push(source); return result.promise; });
  const active = new AbortController(), queued = new AbortController();
  const first = cache.render("active", "dark", active.signal);
  await expect.poll(() => calls).toEqual(["active"]);
  const second = cache.render("queued", "light", queued.signal);
  active.abort(); queued.abort(); result.release("unused");
  expect(await first).toBeNull();
  expect(await second).toBeNull();
  expect(cache.get("active", "dark")).toBeUndefined();
  expect(calls).toEqual(["active"]);
  expect(await cache.render("queued", "light", signal())).toBe("unused");
  expect(calls).toEqual(["active", "queued"]);
});

test("clearing retires old results and queued work without overlapping global rendering", async () => {
  const old = gate<string>();
  const calls: string[] = [];
  const cache = createMermaidCache(async source => {
    calls.push(source);
    return calls.length === 2 ? old.promise : `svg-${calls.length}`;
  });
  await cache.render("cached", "dark", signal());
  const first = cache.render("same", "dark", signal());
  await expect.poll(() => calls).toEqual(["cached", "same"]);
  const queued = cache.render("obsolete", "dark", signal());
  cache.clear();
  expect(cache.get("cached", "dark")).toBeUndefined();
  const fresh = cache.render("same", "dark", signal());
  await Promise.resolve();
  expect(calls).toEqual(["cached", "same"]);
  old.release("old-session");
  expect(await first).toBeNull();
  expect(await queued).toBeNull();
  expect(await fresh).toBe("svg-3");
  expect(calls).toEqual(["cached", "same", "same"]);
  expect(cache.get("same", "dark")).toBe("svg-3");
});

test("render failures remain retryable and do not stall later diagrams or themes", async () => {
  let calls = 0;
  const cache = createMermaidCache(async (source, theme) => {
    if (++calls === 1) throw new Error("Incomplete diagram");
    return `${source}-${theme}`;
  });
  expect(await cache.render("diagram", "dark", signal())).toBeNull();
  expect(cache.get("diagram", "dark")).toBeUndefined();
  expect(await cache.render("diagram", "dark", signal())).toBe("diagram-dark");
  expect(await cache.render("diagram", "light", signal())).toBe("diagram-light");
  expect(await cache.render("changed", "dark", signal())).toBe("changed-dark");
  expect(cache.get("diagram", "dark")).toBe("diagram-dark");
  expect(calls).toBe(4);
});

test("the cache evicts least recently used diagrams at its entry limit", async () => {
  const cache = createMermaidCache(async source => source);
  for (let i = 0; i < MERMAID_CACHE_LIMITS.entries; i++) await cache.render(String(i), "dark", signal());
  expect(cache.get("0", "dark")).toBe("0");
  await cache.render("new", "dark", signal());
  expect(cache.get("1", "dark")).toBeUndefined();
  expect(cache.get("0", "dark")).toBe("0");
  expect(cache.get("new", "dark")).toBe("new");
});

test("the memory budget includes source and SVG; oversized renders do not evict useful entries", async () => {
  const svg = "x".repeat(MERMAID_CACHE_LIMITS.bytes / 4);
  const cache = createMermaidCache(async () => svg);
  await cache.render("one", "dark", signal());
  await cache.render("two", "dark", signal());
  expect(cache.get("one", "dark")).toBeUndefined();
  expect(cache.get("two", "dark")).toBe(svg);
  const oversizedSource = "y".repeat(MERMAID_CACHE_LIMITS.bytes);
  expect(await cache.render(oversizedSource, "dark", signal())).toBe(svg);
  expect(cache.get(oversizedSource, "dark")).toBeUndefined();
  expect(cache.get("two", "dark")).toBe(svg);
});
