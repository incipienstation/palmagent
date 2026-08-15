import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type HTMLAttributes } from "react";
import type { AgentEventKind, AskQuestion, QuestionAnswer } from "@palmagent/shared";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  type LucideProps,
  Terminal,
  User,
  Wrench,
} from "lucide-react";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";

import { ScrollBar } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { describeEvent } from "../format";
import { useOutputMode } from "../OutputModeProvider";
import type { LogItem } from "../hooks/useTaskStream";
import { Markdown } from "./Markdown";

// Kind → foreground token (dual-theme; no inline hex). assistant prose floats in
// strong text; machinery (tool_call/result/status/error/etc.) reads as a quieter,
// rail-grouped band beneath it.
const KIND_CLASS: Record<AgentEventKind, string> = {
  assistant_text: "text-strong",
  status: "text-faint",
  tool_call: "text-tool-call",
  tool_result: "text-muted-foreground",
  result: "text-blue",
  error: "text-destructive",
  approval_request: "text-amber",
  question: "text-question-fg",
};

// Left-rail color per machinery kind — the 2px border that groups a run of
// machinery lines into one visual band.
const KIND_RAIL: Record<Exclude<AgentEventKind, "assistant_text" | "question">, string> = {
  status: "border-l-border",
  tool_call: "border-l-tool-call/60",
  tool_result: "border-l-border",
  result: "border-l-blue/60",
  error: "border-l-destructive/60",
  approval_request: "border-l-amber/60",
};

// A tiny leading glyph per machinery kind — additive, scannable.
const KIND_ICON: Partial<Record<AgentEventKind, ComponentType<LucideProps>>> = {
  tool_call: Wrench,
  tool_result: CheckCircle2,
  result: CheckCircle2,
  status: Terminal,
  error: AlertTriangle,
  approval_request: AlertTriangle,
  question: CircleHelp,
};

function UserBubble({ text, meta }: { text: string; meta?: string }) {
  // Right-aligned soft chat bubble — the human side of the transcript.
  return (
    <div className="mb-3 flex flex-col items-end">
      <div className="mb-1 flex items-center gap-1.5 font-sans text-[11px] font-semibold tracking-wide text-faint uppercase">
        <User className="size-3" aria-hidden />
        You
        {meta && (
          <span className="rounded bg-muted px-1.5 py-px font-sans text-[10px] tracking-normal normal-case text-faint">
            {meta}
          </span>
        )}
      </div>
      <div className="max-w-[85%] rounded-xl rounded-br-sm bg-secondary px-3 py-2 font-sans text-[13.5px] leading-relaxed break-words whitespace-pre-wrap text-secondary-foreground [overflow-wrap:anywhere]">
        {text}
      </div>
    </div>
  );
}

// Read-only record of an AskUserQuestion in the transcript (the live answer UI is
// QuestionCard, rendered separately while the task is awaiting_input).
function QuestionRecord({ questions }: { questions: AskQuestion[] }) {
  return (
    <div className="mb-3 rounded-lg border border-question-border bg-question-bg px-3 py-2.5 font-sans">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-question-fg uppercase">
        <CircleHelp className="size-3" aria-hidden />
        Question
      </div>
      {questions.map((q, i) => (
        <div key={i} className={i > 0 ? "mt-2" : ""}>
          <div className="text-[13.5px] font-semibold text-strong">{q.question}</div>
          <div className="mt-0.5 text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
            {q.options.map((o) => o.label).join(" · ")}
          </div>
        </div>
      ))}
    </div>
  );
}

// One machinery line: a rail-bordered mono row with a leading glyph + a faint
// kind eyebrow + the formatted detail. When there's more behind the one-line
// summary (`full !== detail`) the whole row becomes a tap target (progressive
// disclosure) that toggles to the full, untruncated output — a quiet chevron on
// the right is the only added chrome, and long content wraps/scrolls INSIDE the
// pane (never widening the document). Groups visually with adjacent machinery.
function MachineryLine({
  kind,
  detail,
  full,
  expanded,
  onToggle,
}: {
  kind: Exclude<AgentEventKind, "assistant_text" | "question">;
  detail: string;
  full: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = KIND_ICON[kind];
  const canExpand = full !== detail;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  // Only expandable rows get button semantics — a short, fully-shown line stays a
  // plain div (no spurious "button" announced to screen readers, no tap effect).
  const interactive: HTMLAttributes<HTMLDivElement> = canExpand
    ? {
        role: "button",
        tabIndex: 0,
        "aria-expanded": expanded,
        onClick: onToggle,
        onKeyDown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        },
      }
    : {};
  return (
    <div
      className={cn(
        "mb-1.5 flex gap-2 border-l-2 pl-3 break-words whitespace-pre-wrap [overflow-wrap:anywhere]",
        KIND_RAIL[kind],
        canExpand && "cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
      )}
      {...interactive}
    >
      {Icon && <Icon className={cn("mt-[3px] size-3 shrink-0", KIND_CLASS[kind])} aria-hidden />}
      <div className={cn("min-w-0 flex-1", KIND_CLASS[kind])}>
        <span className="text-faint select-none">{kind}: </span>
        {expanded ? full : detail}
      </div>
      {canExpand && <Chevron className="mt-[3px] size-3 shrink-0 text-faint" aria-hidden />}
    </div>
  );
}

// Mobile-friendly log: a plain scrolling list (no virtualization dep — turns are
// human-scale). Sticks to the bottom while you're already at the bottom, but
// won't yank you down if you've scrolled up to read.
export function EventLog({ log, live, prompt }: { log: LogItem[]; live: boolean; prompt?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Output mode governs machinery density. A row's effective expanded state is the
  // mode default (verbose → expanded) flipped by any explicit per-row toggle, keyed
  // by LogItem.key. Reset the overrides when the mode changes so a switch lands every
  // row on that mode's default rather than an inverted mix.
  const { mode } = useOutputMode();
  const [toggled, setToggled] = useState<Set<number>>(() => new Set());
  useEffect(() => setToggled(new Set()), [mode]);
  const modeExpands = mode === "verbose";
  const isExpanded = (key: number) => (toggled.has(key) ? !modeExpands : modeExpands);
  const toggle = (key: number) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  // The initial prompt now rides the event stream as a `dispatch` status event
  // (so it shows even before the inbox snapshot arrives). Fall back to the
  // `prompt` prop only for older tasks whose log predates that event.
  const hasDispatchEvent = log.some(
    (it) =>
      it.kind === "status" &&
      (it.event.payload as Record<string, unknown> | undefined)?.subtype === "dispatch",
  );

  return (
    <ScrollAreaPrimitive.Root className="relative min-h-0 flex-1 overflow-hidden">
      <ScrollAreaPrimitive.Viewport
        ref={ref}
        onScroll={onScroll}
        className="h-full w-full px-4 pt-3 pb-2 font-mono text-[13px]"
      >
        {!hasDispatchEvent && prompt?.trim() && <UserBubble text={prompt.trim()} />}
        {log.length === 0 && (
          <div className={cn("mb-1.5 [overflow-wrap:anywhere]", KIND_CLASS.status)}>waiting for events…</div>
        )}
        {log.map((item, i) => {
          // status events with subtype steer/followup + text → render as "You" bubble
          if (item.kind === "status") {
            const p = (item.event.payload ?? {}) as Record<string, unknown>;
            const sub = typeof p.subtype === "string" ? p.subtype : "";
            const text = typeof p.text === "string" ? p.text.trim() : "";
            if ((sub === "steer" || sub === "followup" || sub === "dispatch") && text) {
              const meta = p.queued === true ? "queued" : p.injected === true ? "injected" : undefined;
              return <UserBubble key={item.key} text={text} meta={meta} />;
            }
            // The user's answer to an AskUserQuestion → render as a "You" bubble.
            if (sub === "answer") {
              const rows = Array.isArray(p.answers) ? (p.answers as QuestionAnswer[]) : [];
              const summary = rows
                .map((a) => (a.selected?.length ? a.selected.join(", ") : a.notes || "(skipped)"))
                .join(" · ");
              const resp = typeof p.response === "string" ? p.response.trim() : "";
              return (
                <UserBubble
                  key={item.key}
                  text={[summary, resp].filter(Boolean).join(" — ") || "(skipped)"}
                  meta="answer"
                />
              );
            }
          }

          // The agent's question itself → a read-only record of what was asked.
          if (item.kind === "question") {
            const qs = ((item.event.payload as { questions?: AskQuestion[] })?.questions) ?? [];
            return <QuestionRecord key={item.key} questions={qs} />;
          }

          if (item.kind === "assistant_text") {
            const isLast = i === log.length - 1;
            return (
              <div
                className={cn(
                  "mb-2.5 font-sans text-[15px] leading-[22px] break-words [overflow-wrap:anywhere]",
                  KIND_CLASS.assistant_text,
                )}
                key={item.key}
              >
                <Markdown
                  trailing={
                    live && isLast ? (
                      <span className="ml-0.5 inline-block w-[7px] animate-blink bg-live align-text-bottom">
                        &nbsp;
                      </span>
                    ) : undefined
                  }
                >
                  {item.text}
                </Markdown>
              </div>
            );
          }

          // Compact mode drops raw status lifecycle noise (init/turn/reasoning):
          // the meaningful status subtypes already rendered as bubbles above, and
          // tool work + results stay (collapsed). null renders nothing.
          if (mode === "compact" && item.kind === "status") return null;

          return (
            <MachineryLine
              key={item.key}
              kind={item.kind}
              detail={describeEvent(item.event)}
              full={describeEvent(item.event, { full: true })}
              expanded={isExpanded(item.key)}
              onToggle={() => toggle(item.key)}
            />
          );
        })}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
    </ScrollAreaPrimitive.Root>
  );
}
