import { useLayoutEffect, useState } from "react";

/** Fade only the native placeholder; never replace or dim the input itself. */
export function useFadingPlaceholder(placeholder: string, visible: boolean) {
  const [text, setText] = useState(placeholder);
  const [fading, setFading] = useState(false);
  useLayoutEffect(() => {
    if (!visible || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setText(placeholder); setFading(false);
      return;
    }
    if (text === placeholder) { setFading(false); return; }
    setFading(true);
    // Match the 75 ms exit in CSS, followed by a 75 ms entrance.
    const timer = window.setTimeout(() => { setText(placeholder); setFading(false); }, 75);
    return () => window.clearTimeout(timer);
  }, [placeholder, visible, text]);
  return { text, fading };
}
