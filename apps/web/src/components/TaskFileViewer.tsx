import { useTaskFile } from "../hooks/useTaskFile";
import { useEffect, useRef, type ReactNode } from "react";
import { DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { ScrollArea } from "./ui/scroll-area";

type FileReference = { taskId: string; path: string; line?: number };

function FileContents({ taskId, path, line }: FileReference) {
  const { data, error } = useTaskFile(taskId, path);
  const selected = useRef<HTMLElement>(null);
  useEffect(() => { selected.current?.scrollIntoView({ block: "center" }); }, [data, line]);
  if (error) return <p role="alert">{error.message}</p>;
  if (!data) return <p role="status">Loading file…</p>;
  if (!data.text) return <p role="status">This file is empty.</p>;
  if (line === undefined) return <FileScroll>{data.text}</FileScroll>;
  const lines = data.text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  const found = line <= lines.length;
  return <>
    {!found && <p role="status">Line {line} is past the end of this file ({lines.length} lines).</p>}
    <FileScroll>{found ? <>
      {line > 1 && lines.slice(0, line - 1).join("\n") + "\n"}
      <mark ref={selected} aria-label={`Line ${line}`} className="bg-primary/20 text-foreground">{lines[line - 1] || " "}</mark>
      {line < lines.length && "\n" + lines.slice(line).join("\n")}
    </> : data.text}</FileScroll>
  </>;
}

function FileScroll({ children }: { children: ReactNode }) {
  return <ScrollArea orientation="both" className="rounded-md bg-muted" viewportProps={{ tabIndex: 0, "aria-label": "File contents" }}>
    <pre className="w-max min-w-full p-3 font-mono text-sm leading-5">{children}</pre>
  </ScrollArea>;
}

export function TaskFileViewer({ taskId, path, line }: FileReference) {
  return <DialogContent aria-describedby={undefined} className="max-w-4xl">
    <DialogHeader><DialogTitle className="break-all">{path}{line && `:${line}`}</DialogTitle></DialogHeader>
    <FileContents taskId={taskId} path={path} line={line} />
  </DialogContent>;
}
