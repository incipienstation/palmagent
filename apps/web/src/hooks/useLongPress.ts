import { useEffect, useRef, useState, type PointerEvent, type MouseEvent, type KeyboardEvent } from "react";

export function haptic(kind: "open" | "select") {
  try { navigator.vibrate?.(kind === "open" ? 12 : 6); } catch { /* visual feedback is always available */ }
}

// Long press opens controls; its synthetic click must never submit. Movement,
// scrolling, pointer cancellation, a second finger, and unmount all cancel it.
export function useLongPress(open: () => void, click: () => void, disabled = false) {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const origin = useRef<{ x: number; y: number; pointer: number }>();
  const suppress = useRef(false);
  const [pressing, setPressing] = useState(false);
  const latest = useRef({ open, click, disabled }); latest.current = { open, click, disabled };
  const clear = () => { clearTimeout(timer.current); timer.current = undefined; setPressing(false); };
  const cancel = () => { if (origin.current) suppress.current = true; origin.current = undefined; clear(); };
  const reveal = () => { clear(); if (!latest.current.disabled) { haptic("open"); latest.current.open(); } };
  useEffect(() => {
    const otherPointer = (event: globalThis.PointerEvent) => { if (origin.current && event.pointerId !== origin.current.pointer) cancel(); };
    window.addEventListener("pointerdown", otherPointer, true);
    window.addEventListener("scroll", cancel, true);
    window.addEventListener("blur", cancel);
    return () => { window.removeEventListener("pointerdown", otherPointer, true); clearTimeout(timer.current); window.removeEventListener("scroll", cancel, true); window.removeEventListener("blur", cancel); };
  }, []);
  useEffect(() => { if (disabled) cancel(); }, [disabled]);
  return { pressing, handlers: {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (disabled || e.button !== 0 || !e.isPrimary) { cancel(); return; }
      suppress.current = false; origin.current = { x: e.clientX, y: e.clientY, pointer: e.pointerId }; setPressing(true);
      timer.current = setTimeout(() => { suppress.current = true; reveal(); }, 450);
    },
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
      const o = origin.current;
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > 10) cancel();
    },
    // Touch release synthesizes mousedown after the overlay has taken focus.
    // Refocusing the anchor here counts as outside focus and dismisses it before
    // the user can choose. Suppress that default alongside the consumed click.
    onMouseDown: (e: MouseEvent<HTMLButtonElement>) => { if (suppress.current) e.preventDefault(); },
    onPointerUp: () => { origin.current = undefined; clear(); },
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu: (e: MouseEvent<HTMLButtonElement>) => { e.preventDefault(); if (!suppress.current) { suppress.current = true; reveal(); } },
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "ArrowDown" || e.key === "ContextMenu" || e.key === "F10" && e.shiftKey) { e.preventDefault(); reveal(); }
    },
    onClick: (e: MouseEvent<HTMLButtonElement>) => {
      if (suppress.current && e.detail !== 0) { e.preventDefault(); suppress.current = false; return; }
      if (!latest.current.disabled) latest.current.click();
    },
  } };
}
