import { useUpdateState } from "../update-state";
import { useId, useLayoutEffect, useRef } from "react";
import type { AskQuestion, QuestionAnswer } from "@palmagent/shared";
import { Check, CircleHelp, ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { ScrollBar } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// The tap-to-answer UI for a provider question (the task is awaiting_input).
// Mobile-first: each option is a full-width, thumb-sized row; single-select acts
// like a radio, multiSelect toggles. Each question also takes an optional custom
// note. When the agent asks SEVERAL questions at once they page *horizontally* —
// one question per full-width, swipeable slide with a dot pager (position +
// answered state) — so the panel height tracks a single question instead of
// growing into one tall vertical stack that buries the session output above it.
// "Send answer" submits all questions at once; "Skip" declines.
export function QuestionCard({
  questions,
  checkpointKey,
  busy,
  onSubmit,
}: {
  questions: AskQuestion[];
  checkpointKey: string;
  busy: boolean;
  onSubmit: (answers: QuestionAnswer[], skip: boolean) => void;
}) {
  // One selection array + note per question, indexed positionally.
  const [selected, setSelected] = useUpdateState<string[][]>(`question:${checkpointKey}:selected`, () => questions.map(() => []));
  const [notes, setNotes] = useUpdateState<string[]>(`question:${checkpointKey}:notes`, () => questions.map(() => ""));
  // The currently-centered slide, derived from the horizontal scroll position.
  const trackRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useUpdateState(`question:${checkpointKey}:page`, 0);
  const paged = questions.length > 1;
  const id = useId();
  useLayoutEffect(() => {
    if (trackRef.current) trackRef.current.scrollLeft = page * trackRef.current.clientWidth;
  }, []);

  function onScroll() {
    const el = trackRef.current;
    if (!el) return;
    const p = Math.round(el.scrollLeft / el.clientWidth);
    setPage((cur) => (p !== cur ? p : cur));
  }

  function goTo(qi: number) {
    const el = trackRef.current;
    if (el) el.scrollTo({ left: qi * el.clientWidth, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }

  function toggle(qi: number, label: string, multi: boolean) {
    setSelected((prev) => {
      const next = prev.map((a) => a.slice());
      const cur = next[qi];
      if (multi) {
        const at = cur.indexOf(label);
        if (at >= 0) cur.splice(at, 1);
        else cur.push(label);
      } else {
        next[qi] = cur.length === 1 && cur[0] === label ? [] : [label];
      }
      return next;
    });
  }

  const answeredAt = (qi: number) => selected[qi].length > 0 || notes[qi].trim().length > 0;

  const answers: QuestionAnswer[] = questions.map((q, qi) => ({
    ...(q.id ? { questionId: q.id } : {}),
    question: q.question,
    selected: selected[qi],
    notes: notes[qi].trim() || undefined,
  }));
  const hasAny = answers.some((a) => a.selected.length > 0 || a.notes);
  const progress = <p role="status" className="text-xs text-muted-foreground">{busy ? "Sending…" : `${questions.filter((_q, qi) => answeredAt(qi)).length} of ${questions.length} answered`}</p>;

  return (
    // The whole panel is height-capped (max-h) so it can't grow up and bury the
    // session output above it (the composer below is hidden while answering —
    // TaskDetail). It's a flex column: the header / numbered pager / Skip+Send stay
    // pinned and the question SLIDE is the only part that scrolls (vertically as a
    // safety net for a long single question; horizontally to page between many).
    <Card data-question-card aria-busy={busy} className="flex max-h-[46dvh] flex-col overflow-hidden shadow-none">
      <CardHeader className="shrink-0 flex-row items-center justify-between gap-2 border-b border-border p-3">
        <CardTitle className="flex min-w-0 items-center gap-2">
          <CircleHelp className="size-4 shrink-0 text-question-fg" aria-hidden />
          <span className="text-xs">The agent needs your input</span>
        </CardTitle>
        <Badge variant="secondary" className="tabular-nums">{page + 1} / {questions.length}</Badge>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col p-3 pb-0">
      {/* Several questions page horizontally — one per full-width, swipeable slide
          — so the panel shows a SINGLE question at a time instead of one tall
          stack. This track is the flex-1 middle of the capped card: it shrinks to
          fit (min-h-0) and each slide scrolls its own overflow (vertical safety
          net for a long question; horizontal to page between many). A native
          scroll-snap track, NOT a Radix ScrollArea (its horizontal mode regresses
          on this mobile shell); the track is w-full so it scrolls its own
          children, never the document (which is scroll-locked — index.css). */}
      <div
        ref={trackRef}
        onScroll={paged ? onScroll : undefined}
        className={cn(
          "flex w-full min-h-0 flex-1",
          paged &&
            "snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {questions.map((q, qi) => (
          // The slide is a Radix ScrollArea (like EventLog) so a long single
          // question gets a thin, rounded bg-border scrollbar in its own gutter
          // (Viewport pr-2.5) instead of the chunky native bar that floated over the
          // option cards. We use Radix's DEFAULT type ("hover") — same as EventLog —
          // so it AUTO-HIDES: appears while scrolling, fades when idle. (Do NOT set
          // type="always"; that pins it permanently visible, which reads as noise.)
          <ScrollAreaPrimitive.Root
            key={qi}
            className="relative w-full shrink-0 snap-start overflow-hidden"
          >
            <ScrollAreaPrimitive.Viewport className="h-full w-full pr-2.5">
              <div className="flex flex-col gap-2">
              {q.header && (
                <Badge variant="outline">
                  {q.header}
                </Badge>
              )}
              <div id={`${id}-question-${qi}`} className="text-[14px] leading-snug font-semibold text-strong">{q.question}</div>
              {q.multiSelect && <div className="-mt-1 text-[11px] text-faint">Select all that apply</div>}

              <div role="group" aria-labelledby={`${id}-question-${qi}`} className="flex flex-col gap-1.5">
                {q.options.map((opt) => {
                  const on = selected[qi].includes(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      disabled={busy}
                      aria-pressed={on}
                      onClick={() => toggle(qi, opt.label, !!q.multiSelect)}
                      className={cn(
                        "flex min-h-11 w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50",
                        on
                          ? "border-question-active bg-question-active-bg"
                          : "border-border bg-card active:bg-accent",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
                          q.multiSelect ? "rounded" : "rounded-full",
                          on
                            ? "border-question-active bg-question-active text-primary-foreground"
                            : "border-faint",
                        )}
                      >
                        {on && <Check className="size-3" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13.5px] font-medium text-strong">{opt.label}</span>
                        {opt.description && (
                          <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">
                            {opt.description}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>

              <FieldGroup className="gap-2"><Field className="gap-1">
              <FieldLabel htmlFor={`${id}-answer-${qi}`} className="text-xs">Your answer or additional context</FieldLabel>
              <Textarea
                id={`${id}-answer-${qi}`}
                className="min-h-9 resize-none"
                rows={1}
                value={notes[qi]}
                onChange={(e) =>
                  setNotes((prev) => prev.map((n, i) => (i === qi ? e.target.value : n)))
                }
                placeholder="Or type a custom answer…"
                disabled={busy}
              />
              </Field></FieldGroup>
              </div>
            </ScrollAreaPrimitive.Viewport>
            <ScrollBar />
          </ScrollAreaPrimitive.Root>
        ))}
      </div>

      </CardContent>
      <CardFooter className="flex shrink-0 flex-col items-stretch gap-2 p-3">
      {paged && (
        <div className="flex items-center justify-between gap-1">
          <Button variant="ghost" size="icon-lg" aria-label="Previous question" disabled={page === 0 || busy} onClick={() => goTo(page - 1)}><ChevronLeft /></Button>
          {progress}
          <div className="flex min-w-0 gap-1 overflow-x-auto">
          {questions.map((_q, qi) => <Button key={qi} type="button" variant={qi === page ? "selected" : "ghost"} size="icon-lg"
            aria-label={`Go to question ${qi + 1}${answeredAt(qi) ? ", answered" : ""}`} aria-current={qi === page ? "step" : undefined}
            disabled={busy} onClick={() => goTo(qi)}>
            {answeredAt(qi) ? <Check /> : qi + 1}
          </Button>)}
          </div>
          <Button variant="ghost" size="icon-lg" aria-label="Next question" disabled={page === questions.length - 1 || busy} onClick={() => goTo(page + 1)}><ChevronRight /></Button>
        </div>
      )}
      {!paged && progress}
      <div className="flex shrink-0 gap-2">
        <Button
          variant="secondary"
          className="flex-1"
          disabled={busy}
          onClick={() => onSubmit(answers, true)}
        >
          Skip
        </Button>
        <Button
          className="flex-[2]"
          disabled={busy || !hasAny}
          onClick={() => onSubmit(answers, false)}
        >
          {busy && <LoaderCircle data-icon="inline-start" className="motion-safe:animate-spin" />}
          Send answer
        </Button>
      </div>
      </CardFooter>
    </Card>
  );
}
