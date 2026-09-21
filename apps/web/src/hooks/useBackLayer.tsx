import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { registerBackLayer } from "../navigation";

const LayerDepth = createContext(0);
// Inline subpages sit between their containing surface and its nested overlays.
export function useBackLayer(active: boolean, dismiss: () => void, priority = 50) {
  const latest = useRef(dismiss);
  useLayoutEffect(() => { latest.current = dismiss; });
  useLayoutEffect(() => active ? registerBackLayer(() => latest.current(), priority) : undefined, [active, priority]);
}
export function BackLayerScope({ depth, children }: { depth: number; children: ReactNode }) {
  return <LayerDepth.Provider value={depth}>{children}</LayerDepth.Provider>;
}
// Preserve controlled/uncontrolled primitive contracts, including consumers that
// refuse a close during an in-flight save. Radix/Vaul still own focus and gestures.
export function useBackDismiss(props: { open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [local, setLocal] = useState(props.defaultOpen ?? false);
  const open = props.open ?? local;
  const depth = useContext(LayerDepth) + 100;
  const onOpenChange = (value: boolean) => {
    if (props.open === undefined) setLocal(value);
    props.onOpenChange?.(value);
  };
  useBackLayer(open, () => onOpenChange(false), depth);
  return { open, onOpenChange, depth };
}
