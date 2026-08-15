import * as React from "react";

import { Toast, ToastProvider, ToastViewport, type ToastVariant } from "@/components/ui/toast";

// Imperative toast store (module-level, so any screen can call `toast({...})`
// without prop-drilling — mirrors sonner's API but built on Radix Toast).
// The single <Toaster/> in AppShell subscribes and renders the open toasts.

export type ToastOptions = {
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  /** ms before auto-dismiss; default 4000. */
  duration?: number;
};

type ToastRecord = ToastOptions & { id: number; open: boolean };

const MAX = 3;
const DEFAULT_DURATION = 4000;

let counter = 0;
let records: ToastRecord[] = [];
const listeners = new Set<(records: ToastRecord[]) => void>();

function emit() {
  for (const l of listeners) l(records);
}

/** Show a toast. Returns the toast id (so callers can dismiss it early). */
export function toast(options: ToastOptions): number {
  const id = ++counter;
  records = [...records, { ...options, id, open: true }].slice(-MAX);
  emit();
  return id;
}

/** Programmatically dismiss a toast (begins the close animation). */
export function dismissToast(id: number) {
  records = records.map((r) => (r.id === id ? { ...r, open: false } : r));
  emit();
}

function removeToast(id: number) {
  records = records.filter((r) => r.id !== id);
  emit();
}

/** Hook form of the toast API for screens that prefer it. */
export function useToast() {
  return { toast, dismiss: dismissToast };
}

export function Toaster() {
  const [items, setItems] = React.useState<ToastRecord[]>(records);

  React.useEffect(() => {
    const listener = (next: ToastRecord[]) => setItems(next);
    listeners.add(listener);
    setItems(records);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return (
    <ToastProvider swipeDirection="down" duration={DEFAULT_DURATION}>
      {items.map((t) => (
        <Toast
          key={t.id}
          variant={t.variant}
          title={t.title}
          description={t.description}
          duration={t.duration ?? DEFAULT_DURATION}
          open={t.open}
          onOpenChange={(open) => {
            if (!open) dismissToast(t.id);
          }}
          // Radix fires this after the close animation completes.
          onAnimationEnd={() => {
            if (!t.open) removeToast(t.id);
          }}
        />
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
