import { useEffect, useRef, useState, type PointerEvent, type MouseEvent, type KeyboardEvent } from "react";

export function haptic(kind: "open" | "select") {
  try { navigator.vibrate?.(kind === "open" ? 12 : 6); } catch { /* visual feedback is always available */ }
}

// Long press opens controls; its synthetic click must never submit. Movement,
// ancestor scrolling, pointer cancellation, a second finger, and unmount cancel it.
export function useLongPress(open: () => void, click: () => void, disabled = false) {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const origin = useRef<{ x: number; y: number; pointer: number; element: HTMLButtonElement }>();
  const suppress = useRef(false);
  const touch = useRef(false);
  const [pressing, setPressing] = useState(false);
  const latest = useRef({ open, click, disabled }); latest.current = { open, click, disabled };
  const clear = () => { clearTimeout(timer.current); timer.current = undefined; setPressing(false); };
  const cancel = () => { if (origin.current) suppress.current = true; origin.current = undefined; clear(); };
  const reveal = () => { clear(); if (!latest.current.disabled) { haptic("open"); latest.current.open(); } };
  useEffect(() => {
    // A later interaction must regain ordinary outside-focus dismissal.
    const otherPointer = (event: globalThis.PointerEvent) => {
      if (origin.current && event.pointerId !== origin.current.pointer) cancel();
      else if (!origin.current) touch.current = false;
    };
    const keyboard = () => { touch.current = false; };
    const scroll = (event: Event) => {
      const element = origin.current?.element;
      // A streaming transcript is a sibling of the fixed composer. Its scroll
      // does not move the pressed button and must not cancel the user's hold.
      if (element && (event.target === window || event.target instanceof Node && event.target.contains(element))) cancel();
    };
    window.addEventListener("pointerdown", otherPointer, true);
    window.addEventListener("keydown", keyboard, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("blur", cancel);
    return () => { window.removeEventListener("pointerdown", otherPointer, true); window.removeEventListener("keydown", keyboard, true); clearTimeout(timer.current); window.removeEventListener("scroll", scroll, true); window.removeEventListener("blur", cancel); };
  }, []);
  useEffect(() => { if (disabled) cancel(); }, [disabled]);
  return { pressing, onOpenAutoFocus: (event: Event) => {
    // Autofocus blurs the composer and dismisses the phone keyboard mid-hold.
    // The viewport then moves the anchor away from the finger; compatibility
    // mouse events land outside it and dismiss the menu on release.
    if (touch.current) event.preventDefault();
  }, onFocusOutside: (event: Event) => {
    // Focus can move as a phone reflows the composer during the consumed hold.
    // That is still the opening gesture, not a request to dismiss its menu.
    if (touch.current && suppress.current) event.preventDefault();
  }, handlers: {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      touch.current = e.pointerType === "touch";
      if (disabled || e.button !== 0 || !e.isPrimary) { cancel(); return; }
      // Cancel compatibility mouse defaults at their source. A release can be
      // retargeted after mobile reflow, outside this button's mousedown handler.
      // Pointer-event cancellation leaves the ordinary tap's click available.
      if (touch.current) e.preventDefault();
      suppress.current = false; origin.current = { x: e.clientX, y: e.clientY, pointer: e.pointerId, element: e.currentTarget }; setPressing(true);
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
      touch.current = false;
      if (e.key === "ArrowDown" || e.key === "ContextMenu" || e.key === "F10" && e.shiftKey) { e.preventDefault(); reveal(); }
    },
    onClick: (e: MouseEvent<HTMLButtonElement>) => {
      if (e.detail === 0) touch.current = false;
      if (suppress.current && e.detail !== 0) { e.preventDefault(); suppress.current = false; return; }
      if (!latest.current.disabled) latest.current.click();
    },
  } };
}
