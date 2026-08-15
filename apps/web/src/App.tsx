import { AuthGate } from "./auth/AuthGate";
import { useDocumentTitle } from "./hooks/useDocumentTitle";
import { useInbox } from "./hooks/useInbox";
import { useRoute } from "./router";
import { InboxView } from "./components/Inbox";
import { DispatchView } from "./components/DispatchForm";
import { RoutinesView } from "./components/Routines";
import { UsageView } from "./components/Usage";
import { TaskDetailView } from "./components/TaskDetail";

function AppInner() {
  const route = useRoute();
  // The single inbox stream lives for the whole app session, independent of the
  // current view, so the task list stays live everywhere (and we never open more
  // than one /api/stream). The task detail opens its own scoped stream on top.
  const { tasks, conn } = useInbox();

  // Per-route browser/OS title (page-first + brand suffix). Centralized here so
  // the route → page-name map lives in one place; the task page reuses the same
  // title-or-prompt-first-line heading TaskDetail shows. Must run before any
  // early return (rules of hooks).
  const active = route.name === "task" ? tasks.find((t) => t.taskId === route.id) : undefined;
  const pageTitle =
    route.name === "new"
      ? "New task"
      : route.name === "routines"
        ? "Routines"
        : route.name === "usage"
          ? "Usage"
          : route.name === "task"
            ? active?.title?.trim() || active?.prompt.split("\n")[0]?.trim() || "Task"
            : "Tasks";
  useDocumentTitle(pageTitle);

  if (route.name === "new") return <DispatchView />;
  if (route.name === "routines") return <RoutinesView />;
  if (route.name === "usage") return <UsageView />;
  if (route.name === "task") {
    return <TaskDetailView taskId={route.id} task={tasks.find((t) => t.taskId === route.id)} />;
  }
  return <InboxView tasks={tasks} conn={conn} />;
}

export function App() {
  // AuthGate decides login vs app vs enrollment; AppInner (and its live SSE
  // stream) only mounts once authenticated.
  return (
    <AuthGate>
      <AppInner />
    </AuthGate>
  );
}
