import { useSyncExternalStore } from "react";
import { onCacheSessionReset } from "./query-lifecycle";

const changes = new EventTarget();
const retries = new EventTarget();
let waiting = 0;
let delayed = 0;
const publish = () => changes.dispatchEvent(new Event("change"));
const subscribe = (listener: () => void) => {
  changes.addEventListener("change", listener);
  return () => changes.removeEventListener("change", listener);
};

export function useServerRestart() {
  return useSyncExternalStore(subscribe, () => delayed ? "delayed" : waiting ? "restarting" : null);
}

export function retryServerReads() { retries.dispatchEvent(new Event("retry")); }

function waitForRetry(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      retries.removeEventListener("retry", finish);
      if (signal.aborted) reject(signal.reason);
      else resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish);
    retries.addEventListener("retry", finish);
  });
}

/** Hold the original read pending while the server explicitly reports an update.
 * Concurrent reads share the notice and its manual retry, including a cold load. */
export async function recoverUpdateRead<T>(read: () => Promise<T>, isRestart: (error: unknown) => boolean, signal?: AbortSignal) {
  try { return await read(); }
  catch (error) { if (!isRestart(error)) throw error; }

  const session = new AbortController();
  const off = onCacheSessionReset(() => session.abort(new Error("Session changed. Please try again.")));
  const active = signal ? AbortSignal.any([signal, session.signal]) : session.signal;
  let delay = 1000;
  let slow = false;
  waiting++;
  publish();
  try {
    for (;;) {
      await waitForRetry(delay, active);
      active.throwIfAborted();
      try { return await read(); }
      catch (error) { if (!isRestart(error)) throw error; }
      delay = Math.min(delay * 2, 30_000);
      if (!slow && delay >= 16_000) { slow = true; delayed++; publish(); }
    }
  } finally {
    off();
    waiting--;
    if (slow) delayed--;
    publish();
  }
}
