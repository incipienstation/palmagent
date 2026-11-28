import { useLayoutEffect, useRef, useState } from "react";
import { taskTitle, type TaskState } from "@palmagent/shared";

/** Animate a changed provider label only while this task is already on screen. */
export function TaskTitle({ task }: { task: TaskState }) {
  const title = taskTitle(task);
  const provider = !task.title?.trim() && !!task.providerTitle?.trim();
  const previous = useRef({ id: task.taskId, title });
  const [prefix, setPrefix] = useState<string | null>(null);

  useLayoutEffect(() => {
    const changed = previous.current.id === task.taskId && previous.current.title !== title;
    previous.current = { id: task.taskId, title };
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    if (!changed || !provider || motion.matches) {
      setPrefix(null);
      return;
    }

    // Reveal whole graphemes so combining characters and emoji stay together.
    const ends: number[] = [];
    for (const { index, segment } of new Intl.Segmenter().segment(title)) {
      ends.push(index + segment.length);
      if (ends.length === 64) break;
    }
    const start = performance.now();
    const duration = Math.min(700, ends.length * 32);
    let frame = 0;
    function tick(now: number) {
      if (motion.matches || now - start >= duration) { setPrefix(null); return; }
      const count = Math.floor((now - start) / duration * ends.length);
      setPrefix(title.slice(0, ends[count - 1] ?? 0));
      frame = requestAnimationFrame(tick);
    }
    tick(start);
    return () => cancelAnimationFrame(frame);
  }, [task.taskId, provider, title]);

  if (prefix === null) return <>{title}</>;
  return <><span className="sr-only">{title}</span><span aria-hidden="true">{prefix}<span className="invisible">{title.slice(prefix.length)}</span></span></>;
}
