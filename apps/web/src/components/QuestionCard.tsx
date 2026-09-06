import { useRef, useState } from "react";
import type { AskQuestion, QuestionAnswer } from "@palmagent/shared";
import { Check, CircleHelp } from "lucide-react";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollBar } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// The tap-to-answer UI for a Claude AskUserQuestion (the task is awaiting_input).
// Mobile-first: each option is a full-width, thumb-sized row; single-select acts
// like a radio, multiSelect toggles. Each question also takes an optional custom
// note. When the agent asks SEVERAL questions at once they page *horizontally* —
// one question per full-width, swipeable slide with a dot pager (position +
// answered state) — so the panel height tracks a single question instead of
// growing into one tall vertical stack that buries the session output above it.
// "Send answer" submits all questions at once; "Skip" declines.
export function QuestionCard({
  questions,
  busy,
  onSubmit,
}: {
  questions: AskQuestion[];
  busy: boolean;
  onSubmit: (answers: QuestionAnswer[], skip: boolean) => void;
}) {
  // One selection array + note per question, indexed positionally.
  const [selected, setSelected] = useState<string[][]>(() => questions.map(() => []));
  const [notes, setNotes] = useState<string[]>(() => questions.map(() => ""));
  // The currently-centered slide, derived from the horizontal scroll position.
  const trackRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const paged = questions.length > 1;

  function onScroll() {
    const el = trackRef.current;
    if (!el) return;
    const p = Math.round(el.scrollLeft / el.clientWidth);
    setPage((cur) => (p !== cur ? p : cur));
  }

  function goTo(qi: number) {
    const el = trackRef.current;
    if (el) el.scrollTo({ left: qi * el.clientWidth, behavior: "smooth" });
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
    question: q.question,
    selected: selected[qi],
    notes: notes[qi].trim() || undefined,
  }));
  const hasAny = answers.some((a) => a.selected.length > 0 || a.notes);

  return (
    // The whole panel is height-capped (max-h) so it can't grow up and bury the
    // session output above it (the composer below is hidden while answering —
    // TaskDetail). It's a flex column: the header / dot pager / Skip+Send stay
    // pinned and the question SLIDE is the only part that scrolls (vertically as a
    // safety net for a long single question; horizontally to page between many).
    <Card className="flex max-h-[46dvh] flex-col border-question-border bg-question-bg p-3 shadow-none">
      <div className="mb-2 flex shrink-0 items-center gap-1.5 text-[11px] font-semibold tracking-wide text-question-fg uppercase">
        <CircleHelp className="size-3.5" aria-hidden />
        The agent needs your input
        {paged && (
          <span className="ml-auto tabular-nums text-question-fg/70">
            {page + 1} / {questions.length}
          </span>
        )}
      </div>

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
                <span className="self-start rounded bg-question-active/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-question-fg uppercase">
                  {q.header}
                </span>
              )}
              <div className="text-[14px] leading-snug font-semibold text-strong">{q.question}</div>
              {q.multiSelect && <div className="-mt-1 text-[11px] text-faint">Select all that apply</div>}

              <div className="flex flex-col gap-1.5">
                {q.options.map((opt) => {
                  const on = selected[qi].includes(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      disabled={busy}
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

              <Textarea
                className="min-h-9 resize-none"
                rows={1}
                value={notes[qi]}
                onChange={(e) =>
                  setNotes((prev) => prev.map((n, i) => (i === qi ? e.target.value : n)))
                }
                placeholder="Or type a custom answer…"
                disabled={busy}
              />
              </div>
            </ScrollAreaPrimitive.Viewport>
            <ScrollBar />
          </ScrollAreaPrimitive.Root>
        ))}
      </div>

      {/* Dot pager: tap a dot to jump; the current slide is a wider dot, answered
          slides fill with a check so you can see which questions still need input
          before submitting them all at once. */}
      {paged && (
        <div className="mt-2.5 flex shrink-0 items-center justify-center gap-2">
          {questions.map((_q, qi) => {
            const cur = qi === page;
            const done = answeredAt(qi);
            return (
              <button
                key={qi}
                type="button"
                aria-label={`Go to question ${qi + 1}${done ? ", answered" : ""}`}
                aria-current={cur}
                onClick={() => goTo(qi)}
                className="flex h-6 items-center justify-center px-0.5"
              >
                <span
                  className={cn(
                    "flex items-center justify-center rounded-full transition-all",
                    cur ? "size-4" : "size-3",
                    done ? "bg-question-active text-primary-foreground" : "bg-question-fg/25",
                  )}
                >
                  {done && <Check className={cur ? "size-2.5" : "size-2"} strokeWidth={3} />}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-3 flex shrink-0 gap-2">
        <Button
          variant="secondary"
          size="sm"
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
          Send answer
        </Button>
      </div>
    </Card>
  );
}
