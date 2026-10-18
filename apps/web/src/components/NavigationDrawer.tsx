import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Drawer } from "@base-ui/react/drawer";
import { BackLayerScope, useBackDismiss } from "../hooks/useBackLayer";
import { useNavigationGesturesBlocked } from "../NavigationGestureProvider";
import { cn } from "../lib/utils";

// The edge surface owns opening gestures; modal surfaces suspend it through the
// input policy without depending on this drawer implementation.
export function NavigationDrawer({ open, onOpenChange, onAfterClose, desktopSidebar, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAfterClose: () => void;
  desktopSidebar: boolean;
  children: ReactNode;
}) {
  const { depth, ...back } = useBackDismiss({ open, onOpenChange });
  const blocked = useNavigationGesturesBlocked();
  const openedBySwipe = useRef(false);
  useLayoutEffect(() => {
    if (blocked && openedBySwipe.current) {
      openedBySwipe.current = false;
      onOpenChange(false);
    }
  }, [blocked, onOpenChange]);
  return <BackLayerScope depth={depth}>
    <Drawer.Root {...back} swipeDirection="left" onOpenChange={(next, details) => {
      if (next && blocked) { details.cancel(); return; }
      openedBySwipe.current = next && details.reason === "swipe";
      back.onOpenChange(next);
    }} onOpenChangeComplete={next => { if (!next && !blocked) onAfterClose(); }}>
      <Drawer.SwipeArea data-testid="navigation-swipe-area" disabled={blocked}
        className={cn("navigation-swipe-area", desktopSidebar && "md:hidden")} />
      <Drawer.Portal>
        <Drawer.Backdrop className="navigation-drawer-backdrop" />
        <Drawer.Viewport className="navigation-drawer-viewport">
          <Drawer.Popup data-slot="drawer-content" data-side="left" initialFocus finalFocus={false}
            className="navigation-drawer-popup">
            {children}
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  </BackLayerScope>;
}

export const NavigationDrawerTitle = Drawer.Title;
export const NavigationDrawerDescription = Drawer.Description;
