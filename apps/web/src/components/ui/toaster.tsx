import { createPortal } from "react-dom";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import * as DismissableLayer from "@radix-ui/react-dismissable-layer";
import { Toaster as Sonner, toast as notify } from "sonner";

import { useTheme } from "../../ThemeProvider";
import { updateToastClearance } from "../../hooks/useToastObstacle";

export type ToastOptions = {
  title?: ReactNode;
  description?: ReactNode;
  variant?: "default" | "success" | "info" | "destructive";
  duration?: number;
};

let counter = 0;
let current: number | undefined;

/** Keep transient feedback to one message; callers can still dismiss by id. */
export function toast({ title, description, variant, duration }: ToastOptions): number {
  updateToastClearance();
  if (current !== undefined) notify.dismiss(current);
  const id = ++counter;
  current = id;
  notify(title ?? description, {
    id,
    description: title ? description : undefined,
    duration: duration ?? (variant === "destructive" ? 6000 : 2500),
    testId: "toast",
  });
  return id;
}

export function dismissToast(id: number) {
  notify.dismiss(id);
}

export function useToast() {
  return { toast, dismiss: dismissToast };
}

const bottom = "max(calc(24px + var(--safe-bottom)), var(--toast-obstacle-bottom, 0px), calc(var(--keyboard-inset, 0px) + 24px))";

export function Toaster() {
  const { resolved } = useTheme();
  const region = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    updateToastClearance();
    const element = region.current;
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && current !== undefined) notify.dismiss(current);
    };
    element?.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("resize", updateToastClearance);
    window.visualViewport?.addEventListener("resize", updateToastClearance);
    window.visualViewport?.addEventListener("scroll", updateToastClearance);
    return () => {
      element?.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("resize", updateToastClearance);
      window.visualViewport?.removeEventListener("resize", updateToastClearance);
      window.visualViewport?.removeEventListener("scroll", updateToastClearance);
    };
  }, []);

  // Keep the live region outside the app root. Otherwise modal aria hiding
  // keeps that root exposed, including route views mounted during drawer exit.
  return createPortal(<DismissableLayer.Branch asChild><Sonner ref={region} theme={resolved} position="bottom-center" visibleToasts={1}
    closeButton={false} swipeDirections={["bottom"]}
    offset={{ bottom }} mobileOffset={{ bottom }}
    style={{ width: "min(400px, calc(100vw - 32px))", left: "50%", right: "auto", transform: "translateX(-50%)", pointerEvents: "none" }}
    toastOptions={{ unstyled: true, className: "compact-toast" }} /></DismissableLayer.Branch>, document.body);
}
