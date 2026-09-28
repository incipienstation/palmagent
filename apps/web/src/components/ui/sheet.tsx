// Bottom sheets share the Drawer implementation, including Back handling,
// scrolling, spacing, and safe-area padding. Keep these semantic aliases for
// existing supporting-control surfaces; do not fork the layout here.
export {
  Drawer as Sheet,
  DrawerTrigger as SheetTrigger,
  DrawerClose as SheetClose,
  DrawerPortal as SheetPortal,
  DrawerOverlay as SheetOverlay,
  DrawerContent as SheetContent,
  DrawerHeader as SheetHeader,
  DrawerHeaderRow as SheetHeaderRow,
  DrawerBody as SheetBody,
  DrawerFooter as SheetFooter,
  DrawerTitle as SheetTitle,
  DrawerDescription as SheetDescription,
} from "./drawer";
