import { beginBrowserWork } from "./update-state";

// One writer per preference. A later click replaces the target, including while
// a write is in flight; obsolete responses never replace that newer selection.
export function createOptimisticPreference<T>(initial: T, options: {
  save: (value: T, previous: T) => Promise<T>;
  recover: () => Promise<T>;
  equal: (a: T, b: T) => boolean;
  changed: () => void;
  failed: (error: unknown) => void;
}) {
  let confirmed = initial;
  let desired = initial;
  let revision = 0;
  let running = false;
  let disposed = false;
  let stale = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish: (() => void) | undefined;
  const pending = () => running || timer !== undefined;
  const publish = () => {
    if (!pending()) { finish?.(); finish = undefined; }
    if (!disposed) options.changed();
  };
  async function flush() {
    if (disposed || running || timer !== undefined) return;
    const at = revision;
    const target = desired;
    running = true;
    try {
      if (!options.equal(target, confirmed)) confirmed = await options.save(target, confirmed);
      if (at === revision) desired = confirmed;
    } catch (error) {
      const reported = !disposed && at === revision;
      if (reported) {
        desired = confirmed;
        options.failed(error);
        options.changed();
      }
      try { confirmed = await options.recover(); }
      catch { stale = true; }
      if (!disposed && (at === revision || stale)) {
        desired = confirmed;
        if (stale && !reported) options.failed(error);
      }
    } finally {
      running = false;
      if (stale) { clearTimeout(timer); timer = undefined; }
      if (!disposed && !stale && at !== revision && timer === undefined) void flush();
      else publish();
    }
  }
  return {
    get: () => ({ value: desired, pending: pending(), stale }),
    set(value: T) {
      if (disposed || stale) return;
      desired = value;
      revision++;
      finish ??= beginBrowserWork();
      clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void flush(); }, 250);
      publish();
    },
    observe(value: T) {
      if (pending() || disposed) return;
      confirmed = desired = value;
      stale = false;
      publish();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer); timer = undefined;
      finish?.(); finish = undefined;
    },
  };
}
