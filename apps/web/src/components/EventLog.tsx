import { forwardRef, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type HTMLAttributes, type MutableRefObject } from "react";
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
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Button } from "@/components/ui/button";

import { ScrollBar } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { describeEvent } from "../format";
import { useOutputMode, type OutputMode } from "../OutputModeProvider";
import type { LogItem } from "../hooks/useTaskStream";
import { Markdown } from "./Markdown";
import { activityLabel, failed, presentTranscript, type Activity } from "../transcript";

// Kind → foreground token (dual-theme; no inline hex). assistant prose floats in
// strong text; machinery (tool_call/result/status/error/etc.) reads as a quieter,
// rail-grouped band beneath it.
const KIND_CLASS: Record<AgentEventKind, string> = {
  assistant_text: "text-strong",
  output_image: "text-strong",
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
const KIND_RAIL: Record<Exclude<AgentEventKind, "assistant_text" | "question" | "output_image">, string> = {
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
  kind: Exclude<AgentEventKind, "assistant_text" | "question" | "output_image">;
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

type TranscriptRow = { key: string; seq: number } & (
  | { type: "prompt"; text: string }
  | { type: "message"; item: LogItem; raw?: boolean; groupEnd?: boolean }
  | { type: "activity"; activity: Activity; open: boolean }
);
type HistoryControls = {
  hasEarlier?: boolean;
  loadingEarlier?: boolean;
  historyError?: string;
  loadEarlier?: () => void;
  showBeginning?: boolean;
  onScrollPosition?: (element: HTMLElement) => void;
};

// Filter before virtualization: invisible rows must not create zero-height items.
function visible(item: LogItem): boolean {
  if (item.kind !== "output_image") return true;
  const p = item.event.payload as { mediaType?: string; data?: string };
  return !!p?.data && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(p.mediaType ?? "");
}

const EventRow = memo(function EventRow({ item, live, expanded, toggle, onImageLoad, raw = false }: {
  item: LogItem; live: boolean; expanded: boolean; toggle: (key: number) => void; onImageLoad: () => void; raw?: boolean;
}) {

  // status events with subtype steer/followup + text → render as "You" bubble
  if (item.kind === "status") {
    const p = (item.event.payload ?? {}) as Record<string, unknown>;
    const sub = typeof p.subtype === "string" ? p.subtype : "";
    const text = typeof p.text === "string" ? p.text.trim() : "";
    if ((sub === "steer" || sub === "followup" || sub === "dispatch") && text) {
      const meta = p.queued === true ? "queued" : p.injected === true ? "injected" : undefined;
      return <UserBubble text={text} meta={meta} />;
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
          text={[summary, resp].filter(Boolean).join(" — ") || "(skipped)"}
          meta="answer"
        />
      );
    }
  }

  // The agent's question itself → a read-only record of what was asked.
  if (item.kind === "question") {
    const qs = ((item.event.payload as { questions?: AskQuestion[] })?.questions) ?? [];
    return <QuestionRecord questions={qs} />;
  }

  if (item.kind === "output_image") {
    const img = item.event.payload as { mediaType?: string; data?: string };
    if (!img.data || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(img.mediaType ?? "")) return null;
    return <figure className="my-3"><img src={`data:${img.mediaType};base64,${img.data}`} alt="Session output" loading="lazy" onLoad={onImageLoad} className="max-h-96 max-w-full rounded-lg object-contain" /><figcaption className="mt-1 text-xs text-muted-foreground">Session output</figcaption></figure>;
  }
  if (item.kind === "assistant_text") {
    return (
      <div
        className={cn(
          "mb-2.5 font-sans text-[15px] leading-[22px] break-words [overflow-wrap:anywhere]",
          KIND_CLASS.assistant_text,
        )}
      >
        <Markdown
          trailing={
            live ? (
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

  return (
    <MachineryLine
      kind={!raw && failed(item) ? "error" : item.kind}
      detail={raw ? describeEvent(item.event, { full: true }) : failed(item) && (item.kind === "tool_call" || item.kind === "tool_result") ? "Tool failed — expand for details" : describeEvent(item.event)}
      full={describeEvent(item.event, { full: true })}
      expanded={raw || expanded}
      onToggle={() => toggle(item.key)}
    />
  );
});

function HistoryHeader({ context }: { context?: HistoryControls }) {
  if (!context?.hasEarlier && !context?.showBeginning) return <div className="h-3" />;
  return <div className="flex flex-col gap-1 px-4 pt-3 pb-3 font-sans">
    {context.historyError && <span role="alert" className="text-destructive">{context.historyError}</span>}
    <Button variant="ghost" disabled={context.loadingEarlier || context.showBeginning} onClick={context.loadEarlier}>
      {context.showBeginning ? "Beginning of conversation" : context.loadingEarlier ? "Loading earlier messages…" : context.historyError ? "Retry loading earlier messages" : "Load earlier messages"}
    </Button>
  </div>;
}
// Let Virtuoso own scroll coordinates while Radix supplies the viewport and
// scrollbar. Padding belongs in measured header/footer slots, not the scroller.
const TranscriptScroller = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { context: HistoryControls }>(
  function TranscriptScroller({ context, onScroll, ...props }, ref) {
    return <ScrollAreaPrimitive.Viewport {...props} ref={ref} aria-label="Session transcript"
      className="h-full w-full font-mono text-[13px] [overflow-anchor:none]"
      onScroll={(event) => {
        const el = event.currentTarget;
        context.onScrollPosition?.(el);
        onScroll?.(event);
        if (event.currentTarget.scrollTop < 80 && context?.hasEarlier && !context.loadingEarlier && !context.historyError) {
          context.loadEarlier?.();
        }
      }} />;
  },
);
const VIRTUAL_COMPONENTS = { Scroller: TranscriptScroller, Header: HistoryHeader, Footer: () => <div className="h-2" /> };
const rowKey = (_index: number, item: TranscriptRow) => item.key;

// Keep the existing Radix viewport/scrollbar, with Virtuoso measuring dynamic
// rows inside it. Whole-message page boundaries keep existing row keys stable.
function VirtualTranscript({ rows, liveKey, mode, toggled, toggle, toggleActivity, following, ...history }: {
  rows: TranscriptRow[]; liveKey?: number; mode: OutputMode;
  toggled: Set<number>; toggle: (key: number) => void;
  toggleActivity: (activity: Activity, open: boolean) => void; following: MutableRefObject<boolean>;
} & HistoryControls) {
  const virtuoso = useRef<VirtuosoHandle>(null);
  const anchor = useRef<{ key: string; offset: number }>();
  const restoring = useRef(false);
  const viewport = useRef<HTMLElement | null>(null);
  const scrollFrame = useRef(0);
  const hadEarlier = useRef(!!history.hasEarlier);
  hadEarlier.current ||= !!history.hasEarlier;
  const captureAnchor = useCallback(() => {
    const el = viewport.current;
    if (!el || restoring.current) return;
    const bounds = el.getBoundingClientRect();
    const row = Array.from(el.querySelectorAll<HTMLElement>("[data-row-key]"))
      .find((item) => {
        const rect = item.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
    if (row) anchor.current = { key: row.dataset.rowKey!, offset: row.getBoundingClientRect().top - bounds.top };
  }, []);
  const onScrollPosition = useCallback((el: HTMLElement) => {
    following.current = el.scrollHeight - el.clientHeight - el.scrollTop < 80;
    captureAnchor();
  }, [captureAnchor]);
  // Check the reading position when the frame runs, not when a resize was
  // scheduled: a delayed size update must not pull a reader back to the bottom.
  const followBottom = useCallback(() => {
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      const el = viewport.current;
      if (el && following.current) el.scrollTop = el.scrollHeight;
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    // Composer, keyboard, and account-limit updates can resize the viewport
    // without changing any transcript rows.
    const observer = new ResizeObserver(followBottom);
    observer.observe(el);
    return () => observer.disconnect();
  }, [followBottom]);
  const indexing = useRef({ rows, first: 1_000_000_000 });
  const previous = indexing.current;
  if (rows !== previous.rows) {
    if (rows[0].seq < previous.rows[0].seq) {
      const positions = new Map(rows.map((row, index) => [row.key, index]));
      const oldIndex = previous.rows.findIndex((row) => positions.has(row.key));
      if (oldIndex >= 0) previous.first -= positions.get(previous.rows[oldIndex].key)! - oldIndex;
    }
    previous.rows = rows;
  }
  const firstItemIndex = previous.first;
  // Keep the actual visible message and its pixel offset while Virtuoso refines
  // estimates for a prepended page. Its index API retries after row measurement.
  // Live appends must not cancel this adjustment, so it depends on the first key.
  const firstKey = rows[0].seq;
  const previousStart = useRef(firstKey);
  useLayoutEffect(() => {
    const prepended = firstKey < previousStart.current;
    previousStart.current = firstKey;
    if (!prepended || !anchor.current || following.current) return;
    const saved = anchor.current;
    const index = rows.findIndex((row) => row.key === saved.key);
    if (index < 0) return;
    restoring.current = true;
    const frame = requestAnimationFrame(() => {
      virtuoso.current?.scrollIntoView({ index, align: "start",
        calculateViewLocation: ({ locationParams }) => ({ ...locationParams, offset: -saved.offset }),
        done: () => { restoring.current = false; },
      });
    });
    return () => { cancelAnimationFrame(frame); restoring.current = false; };
  }, [firstKey]);
  useLayoutEffect(followBottom, [rows, followBottom]);
  return <Virtuoso<TranscriptRow, HistoryControls>
    ref={virtuoso}
    scrollerRef={(element) => { viewport.current = element instanceof HTMLElement ? element : null; }}
    style={{ height: "100%" }}
    data={rows}
    firstItemIndex={firstItemIndex}
    initialTopMostItemIndex={{ index: "LAST", align: "end" }}
    followOutput={false}
    totalListHeightChanged={followBottom}
    itemsRendered={captureAnchor}
    atBottomThreshold={80}
    increaseViewportBy={{ top: 300, bottom: 200 }}
    computeItemKey={rowKey}
    components={VIRTUAL_COMPONENTS}
    context={{ ...history, onScrollPosition, showBeginning: hadEarlier.current && !history.hasEarlier }}
    itemContent={(_index, row) => <div className="flow-root px-4" data-row-key={row.key}
      data-message-key={row.type === "message" ? row.item.key : undefined}>
      {row.type === "prompt" ? <UserBubble text={row.text} /> : row.type === "activity" ?
        <div data-activity className={cn("min-w-0 font-sans text-muted-foreground", !row.open && "mb-2")}>
          <Button variant="ghost" className="group w-full justify-start px-0" title={activityLabel(row.activity, mode)}
            aria-expanded={row.open} onClick={() => toggleActivity(row.activity, !row.open)}>
            <ChevronRight data-icon="inline-start" className={row.open ? "rotate-90" : undefined} />
            <span className="truncate">{activityLabel(row.activity, mode)}</span>
          </Button>
          {!row.open && row.activity.preview && <div data-progress-preview className={cn("text-[13px] break-words [overflow-wrap:anywhere]", mode === "compact" ? "line-clamp-1" : "line-clamp-2")}>{row.activity.preview}</div>}
        </div> : <div data-activity={row.raw || undefined} className={cn(row.raw && "font-mono text-[12px]", row.groupEnd && "pb-4")}>
          <EventRow item={row.item} live={row.item.key === liveKey} raw={row.raw}
            expanded={toggled.has(row.item.key) ? mode !== "verbose" : mode === "verbose"} toggle={toggle} onImageLoad={followBottom} />
        </div>}
    </div>}
  />;
}

export function EventLog({ log, live, prompt, loading = false, ...history }: {
  log: LogItem[]; live: boolean; prompt?: string; loading?: boolean;
} & HistoryControls) {
  const { mode } = useOutputMode();
  // Expansion state survives virtual row unmounting. Activity tracks member keys
  // because a late phase marker can change a group's leading key.
  const following = useRef(true);
  const [toggled, setToggled] = useState<Set<number>>(() => new Set());
  const [openActivity, setOpenActivity] = useState<Set<number>>(() => new Set());
  useEffect(() => { setToggled(new Set()); setOpenActivity(new Set()); following.current = true; }, [mode]);
  const toggle = useCallback((key: number) => {
    following.current = false;
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
  const toggleActivity = useCallback((activity: Activity, open: boolean) => {
    following.current = false;
    setOpenActivity((prev) => {
      const next = new Set(prev);
      for (const item of activity.items) { if (open) next.add(item.key); else next.delete(item.key); }
      return next;
    });
  }, []);
  const rows = useMemo<TranscriptRow[]>(() => {
    const rows: TranscriptRow[] = [];
    const hasDispatch = log.some((item) => item.kind === "status" &&
      (item.event.payload as { subtype?: string } | null)?.subtype === "dispatch");
    if (!hasDispatch && prompt?.trim()) rows.push({ key: "prompt", seq: 0, type: "prompt", text: prompt.trim() });
    for (const row of presentTranscript(log, mode, live)) {
      if (row.type === "message") {
        if (visible(row.item)) rows.push({ ...row, key: `message-${row.key}`, seq: row.key });
      } else {
        const open = row.items.some((item) => openActivity.has(item.key));
        rows.push({ key: `activity-${row.key}`, seq: row.key, type: "activity", activity: row, open });
        // Expanded activity is virtualized too: a long turn must not mount all
        // its tool outputs inside one oversized disclosure row.
        if (open) {
          const items = row.items.filter(visible);
          for (const [index, item] of items.entries()) rows.push({ key: `raw-${item.key}`, seq: item.key,
            type: "message", item, raw: true, groupEnd: index === items.length - 1 });
        }
      }
    }
    return rows;
  }, [log, mode, live, prompt, openActivity]);
  return <ScrollAreaPrimitive.Root className="relative min-h-0 flex-1 overflow-hidden">
    {rows.length > 0 ? <VirtualTranscript key={mode} rows={rows}
      liveKey={live ? log.at(-1)?.key : undefined} mode={mode} toggled={toggled} toggle={toggle} toggleActivity={toggleActivity} following={following} {...history} /> :
      <ScrollAreaPrimitive.Viewport aria-label="Session transcript" className="h-full w-full px-4 font-mono text-[13px]">
        <HistoryHeader context={history} /><div className="mb-1.5 text-faint">
          {loading ? "Loading history…" : log.length ? "No messages in this view." : "waiting for events…"}
        </div>
      </ScrollAreaPrimitive.Viewport>}
    <ScrollBar />
  </ScrollAreaPrimitive.Root>;
}
