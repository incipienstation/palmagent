import { useSyncExternalStore } from "react";
import { onCacheSessionReset } from "./query-lifecycle";

type Waiting = { label: string; stop: () => void };
const waiting = new Map<string, Waiting>();
const active = new Map<string, AbortController>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useMessageRetry = (scope: string) => useSyncExternalStore(subscribe, () => waiting.get(scope));

export class MessageRetryStopped extends Error {
  constructor() { super("Automatic retry stopped. Check delivery before sending again."); this.name = "MessageRetryStopped"; }
}

onCacheSessionReset(() => {
  for (const controller of active.values()) controller.abort(new Error("Session changed. Please try again."));
  waiting.clear(); emit();
});

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Only callers with a durable, unchanged request ID may use this transport retry.
 * The enclosing write remains browser work, so a controlled PWA replacement waits
 * for its receipt. This never replays provider delivery or changes the target run.
 */
export async function retryMessage<T>(scope: string, send: (signal: AbortSignal) => Promise<T>,
  retryLabel: (error: unknown) => string | undefined): Promise<T> {
  if (active.has(scope)) throw new Error("A message is already being sent.");
  const controller = new AbortController();
  active.set(scope, controller);
  const deadline = setTimeout(() => controller.abort(new Error("Connection did not recover. Your message is preserved; check delivery before retrying.")), 120_000);
  let attempt = 0;
  try {
    for (;;) {
      controller.signal.throwIfAborted();
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new DOMException("Message request timed out", "TimeoutError")), 15_000);
      const signal = AbortSignal.any([controller.signal, timeout.signal]);
      try { return await abortable(send(signal), signal); }
      catch (error) {
        controller.signal.throwIfAborted();
        const label = retryLabel(error);
        if (!label) throw error;
        waiting.set(scope, { label, stop: () => controller.abort(new MessageRetryStopped()) });
        emit();
      } finally { clearTimeout(timer); }
      let pauseTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await abortable(new Promise<void>(resolve => { pauseTimer = setTimeout(resolve, Math.min(1000 * 2 ** attempt++, 5000)); }), controller.signal);
      } finally { clearTimeout(pauseTimer); }
    }
  } finally {
    clearTimeout(deadline);
    active.delete(scope); waiting.delete(scope); emit();
  }
}
