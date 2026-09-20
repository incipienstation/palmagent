import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { TaskState } from "@palmagent/shared";
import { BarChart3, Check, Clock3, Folder, Inbox, PanelLeftClose, Settings, SquarePen, Terminal } from "lucide-react";
import type { ConnState } from "../hooks/useInbox";
import { useUpdateState } from "../update-state";
import { navigate, useRoute } from "../router";
import { taskTitle } from "../lib/task-title";
import { Button } from "./ui/button";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "./ui/drawer";
import { SettingsSheet } from "./SettingsSheet";

const NavigationContext = createContext<{
  openNavigation: (trigger: HTMLButtonElement) => void;
  spacesOpen: boolean;
  setSpacesOpen: (open: boolean) => void;
} | null>(null);

export const useAppNavigation = () => useContext(NavigationContext);

// Keep navigation outside route views so closing a drawer never loses its
// animation, focus restoration, or the app's single shared inbox stream.
export function AppNavigation({ tasks, conn, children }: {
  tasks: TaskState[]; conn: ConnState; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [spacesOpen, setSpacesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useUpdateState("settings:open", false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const afterClose = useRef<(() => void) | null>(null);
  const route = useRoute();
  const recent = useMemo(() => tasks.filter(task => task.status !== "archived")
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, 20), [tasks]);
  const attention = tasks.some(task => task.status === "awaiting_input" || task.status === "awaiting_approval");
  const openNavigation = useCallback((element: HTMLButtonElement) => {
    trigger.current = element;
    setOpen(true);
  }, []);
  const context = useMemo(() => ({ openNavigation, spacesOpen, setSpacesOpen }), [openNavigation, spacesOpen]);
  const restoreFocus = () => {
    const target = trigger.current?.isConnected ? trigger.current : document.querySelector<HTMLButtonElement>('button[aria-label="Open navigation"]');
    target?.focus();
  };
  const go = (path: string) => { setOpen(false); navigate(path); };
  const showAfterClose = (action: () => void) => { afterClose.current = action; setOpen(false); };
  const destinations = [
    { label: "Tasks", icon: Inbox, active: route.name === "inbox", onClick: () => go("/"), attention },
    { label: "Spaces", icon: Folder, active: false, onClick: () => {
      navigate("/"); showAfterClose(() => setSpacesOpen(true));
    } },
    { label: "Routines", icon: Clock3, active: route.name === "routines", onClick: () => go("/routines") },
    { label: "Terminals", icon: Terminal, active: route.name === "terminals", onClick: () => go("/terminals") },
    { label: "Usage", icon: BarChart3, active: route.name === "usage", onClick: () => go("/usage") },
  ];
  return <NavigationContext.Provider value={context}>
    {children}
    <Drawer direction="left" open={open} onOpenChange={setOpen} autoFocus>
      <DrawerContent side="left" onCloseAutoFocus={(event) => {
        event.preventDefault();
        const action = afterClose.current;
        afterClose.current = null;
        if (action) action();
        else restoreFocus();
      }}>
        <div className="flex shrink-0 items-center gap-3 px-5 pt-[calc(12px+var(--safe-top))] pb-4">
          <DrawerTitle className="text-xl tracking-tight">Palmagent</DrawerTitle>
          <Button variant="ghost" size="icon-lg" aria-label="Close navigation" onClick={() => setOpen(false)}><PanelLeftClose /></Button>
        </div>
        <DrawerDescription className="sr-only">Navigate your tasks, spaces, and settings.</DrawerDescription>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <nav aria-label="Main navigation" className="shrink-0 space-y-1 px-3 pb-4">
          {destinations.map(({ label, icon: Icon, active, onClick, attention: needsAttention }) => <Button key={label}
            variant={active ? "selected" : "ghost"} className="h-12 w-full justify-start gap-3 rounded-xl border-transparent px-3 text-base font-medium"
            aria-label={label} aria-description={needsAttention ? "Tasks need attention" : undefined} aria-current={active ? "page" : undefined} onClick={onClick}>
            <Icon className="size-5" /><span className="flex-1 text-left">{label}</span>
            {needsAttention && <span className="size-2 rounded-full bg-amber" aria-label="Tasks need attention" />}
            {active && <Check className="size-4" />}
          </Button>)}
        </nav>
        <div className="mx-5 border-t border-border" />
        <div className="px-3 py-4">
          <h2 className="px-3 pb-2 text-xs font-medium text-muted-foreground">Recent tasks</h2>
          {recent.length === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">Your tasks will appear here.</p>}
          {recent.map(task => <Button key={task.taskId} variant={route.name === "task" && route.id === task.taskId ? "selected" : "ghost"}
            className="h-11 w-full justify-start rounded-xl px-3 text-sm font-normal"
            aria-current={route.name === "task" && route.id === task.taskId ? "page" : undefined}
            onClick={() => go(`/task/${encodeURIComponent(task.taskId)}`)}>
            <span className="truncate">{taskTitle(task)}</span>
          </Button>)}
        </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 px-5 pt-3 pb-[calc(16px+var(--safe-bottom))]">
          <Button className="rounded-full px-5" onClick={() => go("/new")}><SquarePen />New task</Button>
          <Button variant="ghost" size="icon-lg" className="ml-auto rounded-full" aria-label="Settings" onClick={() => showAfterClose(() => setSettingsOpen(true))}><Settings /></Button>
        </div>
      </DrawerContent>
    </Drawer>
    <SettingsSheet conn={conn} open={settingsOpen} onOpenChange={setSettingsOpen}
      onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }} />
  </NavigationContext.Provider>;
}
