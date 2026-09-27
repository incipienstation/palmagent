import { TerminalsView } from "./components/Terminals";
import { AppNavigation } from "./components/AppNavigation";
import { taskTitle } from "./lib/task-title";
import { useAccessUpdates } from "./hooks/useAccessUpdates";
import { AuthGate } from "./auth/AuthGate";
import { useDocumentTitle } from "./hooks/useDocumentTitle";
import { useInbox } from "./hooks/useInbox";
import { useRoute } from "./router";
import { SpacesView } from "./components/Spaces";
import { useRepos } from "./hooks/useRepos";
import { InboxView } from "./components/Inbox";
import { useState } from "react";
import type { TaskState } from "@palmagent/shared";
import { navigate } from "./router";
import { RoutinesView } from "./components/Routines";
import { UsageView } from "./components/Usage";
import { TaskDetailView } from "./components/TaskDetail";
import { ModelCatalogProvider } from "./model-catalog";

function AppInner() {
  const route = useRoute();
  const [created, setCreated] = useState<TaskState>();
  const routeKey = route.name === "task" ? route.id : route.name === "new" ? `new:${route.repoId ?? "all"}` : route.name;
  const [conversation, setConversation] = useState<{ key: number; route: string; taskId?: string }>({ key: 0, route: routeKey });
  if (conversation.route !== routeKey) setConversation({
    route: routeKey, key: conversation.key + (route.name === "new" ? 1 : 0),
    taskId: route.name === "new" ? undefined : conversation.taskId,
  });
  // Keep the new conversation mounted when its server ID arrives. Other task
  // navigation still gets a fresh controller and scroll/draft scope.
  const onCreated = (task: TaskState) => {
    setCreated(task);
    setConversation(current => ({ ...current, taskId: task.taskId }));
    navigate(`/task/${encodeURIComponent(task.taskId)}`, { replace: true });
  };
  // The single inbox stream lives for the whole app session, independent of the
  // current view, so the task list stays live everywhere (and we never open more
  // than one /api/stream). The task detail opens its own scoped stream on top.
  const { tasks, conn, loading } = useInbox();
  useAccessUpdates(conn);
  const { repos } = useRepos();

  // Per-route browser/OS title (page-first + brand suffix). Centralized here so
  // the route → page-name map lives in one place; the task page reuses the same
  // title-or-prompt-first-line heading TaskDetail shows. Must run before any
  // early return (rules of hooks).
  const listed = route.name === "task" ? tasks.find(t => t.taskId === route.id) : undefined;
  const active = route.name === "task" && created?.taskId === route.id && (!listed || created.updatedAt >= listed.updatedAt)
    ? created : listed;
  const pageTitle =
    route.name === "terminals" ? "Terminals" : route.name === "new"
      ? "New task"
      : route.name === "routines"
        ? "Routines"
        : route.name === "usage"
          ? "Usage"
          : route.name === "task"
            ? active ? taskTitle(active) : "Task"
            : route.name === "spaces" ? "Spaces" : route.name === "space" ? repos.get(route.repoId)?.name ?? "Space" : "All spaces";
  useDocumentTitle(pageTitle);

  const view = route.name === "terminals" ? <TerminalsView key={route.taskId ?? route.repoId ?? "all"} repoId={route.repoId} taskId={route.taskId} />
    : route.name === "routines" ? <RoutinesView />
    : route.name === "usage" ? <UsageView />
    : route.name === "task" || route.name === "new" ? <TaskDetailView key={route.name === "new" || route.id === conversation.taskId ? `new-${conversation.key}` : route.id} taskId={route.name === "task" ? route.id : undefined} initialRepoId={route.name === "new" ? route.repoId : undefined} task={active} onCreated={onCreated} />
    : route.name === "spaces" ? <SpacesView tasks={tasks} conn={conn} loading={loading} />
    : <InboxView key={route.name === "space" ? route.repoId : "all"} repoId={route.name === "space" ? route.repoId : undefined} tasks={tasks} conn={conn} loading={loading} />;
  return <AppNavigation tasks={tasks} conn={conn}>{view}</AppNavigation>;
}

export function App() {
  // AuthGate decides login vs app vs enrollment; AppInner (and its live SSE
  // stream) only mounts once authenticated.
  return (
    <AuthGate>
      <ModelCatalogProvider><AppInner /></ModelCatalogProvider>
    </AuthGate>
  );
}
