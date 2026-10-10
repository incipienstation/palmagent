import { onConversationNotification } from "../conversation-notifications";
import { needsTaskAttention } from "@palmagent/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TaskState } from "@palmagent/shared";
import { BarChart3, Check, Clock3, Folder, Gamepad2, ListTodo, PanelLeftClose, Pin, Settings, SquarePen, Terminal } from "lucide-react";
import type { ConnState } from "../hooks/useInbox";
import { useUpdateState } from "../update-state";
import { navigate, useRoute } from "../router";
import { compareTasks } from "../lib/task-order";
import { taskTitle } from "../lib/task-title";
import { useRepos } from "../hooks/useRepos";
import { newTaskPath, spaceActivity, spacePath } from "../space-context";
import { ScrollArea } from "./ui/scroll-area";
import { Button } from "./ui/button";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "./ui/drawer";
import { SettingsSheet } from "./SettingsSheet";
import { useArcadeMode } from "../ArcadeModeProvider";
import { SurvivorSheet } from "../games/SurvivorSheet";
import { onGameDelivery, warmSurvivor, type GameDelivery } from "../games/play-events";

const NavigationContext = createContext<{
  openNavigation: (trigger: HTMLButtonElement) => void;
  openGame?: (trigger: HTMLButtonElement) => void;
  desktopSidebar: boolean;
} | null>(null);

export const useAppNavigation = () => useContext(NavigationContext);

// Keep navigation outside route views so closing a drawer never loses its
// animation, focus restoration, or the app's single shared inbox stream.
export function AppNavigation({ tasks, conn, children }: {
  tasks: TaskState[]; conn: ConnState; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { enabled: arcadeMode } = useArcadeMode();
  const [gameOpen, setGameOpen] = useState(false);
  const [delivery, setDelivery] = useState<GameDelivery>();
  const newGameConversation = useRef(false);
  useEffect(() => {
    if (!arcadeMode) { setGameOpen(false); setDelivery(undefined); return; }
    void warmSurvivor();
    return onGameDelivery(event => {
      if (event.state === "sending") {
        newGameConversation.current = !event.taskId;
        const active = document.activeElement;
        if (active instanceof HTMLElement) { trigger.current = active; active.blur(); }
        setDelivery(event); setGameOpen(true);
      } else setDelivery(current => current?.id === event.id ? event : current);
    });
  }, [arcadeMode]);
  const { repos } = useRepos();
  const [settingsOpen, setSettingsOpen] = useUpdateState("settings:open", false);
  const trigger = useRef<HTMLElement | null>(null);
  const afterClose = useRef<(() => void) | null>(null);
  const route = useRoute();
  const gameTaskId = route.name === "task" ? route.id : delivery?.taskId;
  const automaticGameClose = useRef(false);
  useEffect(() => onConversationNotification(({ taskId, initial }) => {
    if (!gameOpen || taskId !== gameTaskId || (initial && !newGameConversation.current)) return;
    automaticGameClose.current = true;
    setGameOpen(false);
  }), [gameOpen, gameTaskId]);
  const pinned = useMemo(() => tasks.filter(task => task.status !== "archived" && task.pinnedAt !== undefined).sort(compareTasks), [tasks]);
  const recent = useMemo(() => tasks.filter(task => task.status !== "archived" && task.pinnedAt === undefined)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, 20), [tasks]);
  const attention = tasks.some(task => needsTaskAttention(task.status));
  const openNavigation = useCallback((element: HTMLButtonElement) => {
    trigger.current = element;
    setOpen(true);
  }, []);
  const openGame = useCallback((element: HTMLButtonElement) => {
    trigger.current = element;
    newGameConversation.current = false;
    setDelivery(undefined); setGameOpen(true);
  }, []);
  const desktopSidebar = ["inbox", "space", "spaces"].includes(route.name);
  const context = useMemo(() => ({ openNavigation, desktopSidebar, openGame: arcadeMode ? openGame : undefined }), [openNavigation, desktopSidebar, arcadeMode, openGame]);
  const restoreFocus = () => {
    const target = trigger.current?.isConnected ? trigger.current : document.querySelector<HTMLButtonElement>('button[aria-label="Open navigation"]');
    target?.focus();
  };
  const go = (path: string) => { setOpen(false); navigate(path); };
  const showAfterClose = (action: () => void) => { afterClose.current = action; setOpen(false); };
  const destinations = [
    { label: "Tasks", icon: ListTodo, active: route.name === "inbox", onClick: () => go("/"), attention },
    { label: "Spaces", icon: Folder, active: route.name === "spaces", onClick: () => go("/spaces") },
    { label: "Routines", icon: Clock3, active: route.name === "routines", onClick: () => go("/routines") },
    { label: "Terminals", icon: Terminal, active: route.name === "terminals", onClick: () => go("/terminals") },
    { label: "Agents", icon: BarChart3, active: route.name === "usage", onClick: () => go("/agents") },
  ];
  const navigationLinks = (
        <nav aria-label="Main navigation" className="shrink-0 flex flex-col gap-1 px-3 pb-4">
          {destinations.map(({ label, icon: Icon, active, onClick, attention: needsAttention }) => <Button key={label}
            variant={active ? "selected" : "ghost"} className="h-12 w-full justify-start gap-3 rounded-xl border-transparent px-3 text-base font-medium"
            aria-label={label} aria-description={needsAttention ? "Tasks need attention" : undefined} aria-current={active ? "page" : undefined} onClick={onClick}>
            <Icon className="size-5" /><span className="flex-1 text-left">{label}</span>
            {needsAttention && <span className="size-2 rounded-full bg-amber" aria-label="Tasks need attention" />}
            {active && <Check className="size-4" />}
          </Button>)}
          {arcadeMode && <Button variant="ghost" className="h-12 w-full justify-start gap-3 px-3" onClick={event => {
            if (open) showAfterClose(() => { newGameConversation.current = false; setDelivery(undefined); setGameOpen(true); });
            else openGame(event.currentTarget);
          }}><Gamepad2 data-icon="inline-start" />Arcade</Button>}
        </nav>
  );
  const pinnedNavigation = (pinned.length > 0 && <section aria-label="Pinned" className="px-3 pt-4">
          <h2 className="px-3 pb-2 text-xs font-medium text-muted-foreground">Pinned</h2>
          {pinned.map(task => <Button key={task.taskId} variant={route.name === "task" && route.id === task.taskId ? "selected" : "ghost"}
            className="h-11 w-full justify-start rounded-xl px-3 text-sm font-normal"
            aria-current={route.name === "task" && route.id === task.taskId ? "page" : undefined}
            onClick={() => go(`/task/${encodeURIComponent(task.taskId)}`)}>
            <Pin data-icon="inline-start" /><span className="truncate">{taskTitle(task)}</span>
          </Button>)}
        </section>
  );
  const recentSpaces = [...repos.values()].sort((a, b) => spaceActivity(b.id, tasks).latest - spaceActivity(a.id, tasks).latest || a.name.localeCompare(b.name)).slice(0, 6);
  const newTask = () => go(newTaskPath(route.name === "space" ? route.repoId : undefined));
  return <NavigationContext.Provider value={context}>
    <div className={desktopSidebar ? "mx-auto flex max-w-[1360px]" : undefined}>
      {desktopSidebar && <aside aria-label="Space navigation" className="hidden h-app w-60 shrink-0 flex-col border-r md:flex">
        <p className="px-6 pb-5 pt-[calc(24px+var(--safe-top))] text-lg font-semibold">Palmagent</p>
        {navigationLinks}
        <ScrollArea className="flex-1">
          {pinnedNavigation}
          <div className="px-3">
          <h2 className="px-3 py-3 text-xs text-muted-foreground">Recent Spaces</h2>
          {recentSpaces.map(repo => <Button key={repo.id} variant={route.name === "space" && route.repoId === repo.id ? "selected" : "ghost"} className="w-full justify-start px-3" aria-current={route.name === "space" && route.repoId === repo.id ? "page" : undefined} onClick={() => go(spacePath(repo.id))}><span className="truncate">{repo.name}</span></Button>)}
          </div>
        </ScrollArea>
        <div className="flex items-center gap-2 p-4 pb-[calc(16px+var(--safe-bottom))]"><Button onClick={newTask}><SquarePen data-icon="inline-start" />New task</Button><Button variant="ghost" size="icon-lg" aria-label="Settings" onClick={event => { trigger.current = event.currentTarget; setSettingsOpen(true); }}><Settings /></Button></div>
      </aside>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
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
        <ScrollArea className="flex-1">
        {navigationLinks}

        <div className="mx-5 border-t border-border" />
        {pinnedNavigation}
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
        </ScrollArea>
        <div className="flex shrink-0 items-center gap-3 px-5 pt-3 pb-[calc(16px+var(--safe-bottom))]">
          <Button className="rounded-full px-5" onClick={newTask}><SquarePen />New task</Button>
          <Button variant="ghost" size="icon-lg" className="ml-auto rounded-full" aria-label="Settings" onClick={() => showAfterClose(() => setSettingsOpen(true))}><Settings /></Button>
        </div>
      </DrawerContent>
    </Drawer>
    <SettingsSheet conn={conn} open={settingsOpen} onOpenChange={setSettingsOpen}
      onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }} />
    {arcadeMode && <SurvivorSheet open={gameOpen} onOpenChange={setGameOpen}
      tasks={tasks} delivery={delivery} taskId={gameTaskId} conn={conn}
      onReturn={taskId => { setGameOpen(false); if (taskId && (route.name !== "task" || route.id !== taskId)) navigate(`/task/${encodeURIComponent(taskId)}`); }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (automaticGameClose.current) {
          automaticGameClose.current = false;
          // A send may have opened the game from the composer. Return focus to
          // a visible control without reopening the mobile keyboard.
          document.querySelector<HTMLButtonElement>('button[aria-label="Open arcade"]')?.focus({ preventScroll: true });
        } else restoreFocus();
      }} />}
  </NavigationContext.Provider>;
}
