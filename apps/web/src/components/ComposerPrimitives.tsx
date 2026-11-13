import { useLayoutEffect, useRef, type ComponentProps, type RefObject } from "react";
import { ArrowUp, Loader2, Square } from "lucide-react";
import { useSendShortcut } from "../SendShortcutProvider";
import { useKeyboardDismiss } from "../hooks/useKeyboardDismiss";
import { useFadingPlaceholder } from "../hooks/useFadingPlaceholder";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { InputGroup, InputGroupTextarea } from "./ui/input-group";
import { ComposerScrollbar } from "./ComposerScrollbar";

export function ComposerSurface({ className, pending, ...props }: ComponentProps<typeof InputGroup> & { pending?: boolean }) {
  return <InputGroup className={cn("composer overflow-clip rounded-3xl p-1", pending && "composer-pending", className)} {...props} />;
}

/** Shared native input behavior for task and side-chat composers. */
export function ComposerInput({ textarea, composing: externalComposing, expanded, hidden: compactVoice = false,
  value, placeholder = "", cannotSend, onSend, submitOnEnter, onKeyDown, ...props }: Omit<ComponentProps<"textarea">, "value" | "ref"> & {
  textarea: RefObject<HTMLTextAreaElement | null>;
  composing?: RefObject<boolean>;
  expanded: boolean;
  value: string;
  cannotSend?: boolean;
  onSend?: () => void;
  submitOnEnter?: boolean;
}) {
  const localComposing = useRef(false);
  const composing = externalComposing ?? localComposing;
  const { shortcut } = useSendShortcut();
  const hint = useFadingPlaceholder(placeholder, value.length === 0 && !compactVoice);
  useKeyboardDismiss(textarea);
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el || compactVoice) return;
    const resize = () => {
      // Measure without animating through zero. Resume from the current visual
      // height so a focus reversal during the transition remains continuous.
      const current = el.getBoundingClientRect().height;
      const { paddingLeft, paddingRight } = getComputedStyle(el);
      el.style.transition = "none";
      el.style.height = "0px";
      el.style.paddingLeft = el.style.paddingRight = "12px";
      const target = expanded ? Math.max(56, Math.min(el.scrollHeight, 144)) : 44;
      el.style.height = `${current}px`;
      el.style.paddingLeft = paddingLeft;
      el.style.paddingRight = paddingRight;
      void el.offsetHeight;
      el.style.transition = "";
      el.style.paddingLeft = el.style.paddingRight = "";
      el.style.height = `${target}px`;
    };
    resize();
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      // Width changes can wrap text without a value change (rotation/split view).
      if (width !== el.clientWidth) { width = el.clientWidth; resize(); }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [value, expanded, compactVoice]);

  return <div className="relative order-1 basis-full" hidden={compactVoice}>
    <InputGroupTextarea {...props} ref={textarea} value={value} rows={1}
      aria-keyshortcuts={shortcut === "enter" ? "Enter Meta+Enter Control+Enter" : "Meta+Enter Control+Enter"}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onBlur={() => { composing.current = false; }}
      onKeyDown={event => {
        // IME confirmation can arrive after compositionend with keyCode 229.
        if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey || event.altKey) return;
        if (shortcut !== "enter" && !event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        if (event.repeat || cannotSend) return;
        if (onSend) onSend();
        else if (submitOnEnter) event.currentTarget.form?.requestSubmit();
      }}
      hidden={compactVoice} placeholder={hint.text} data-placeholder-fading={hint.fading}
      className="composer-input block w-full max-h-36 px-3 py-2.5"
    />
    <ComposerScrollbar textarea={textarea} value={value} />
  </div>;
}

export function ComposerAction({ stop, busy, ...props }: Omit<ComponentProps<typeof Button>, "children"> & { stop?: boolean; busy?: boolean }) {
  return <Button type="button" variant="ghost" size="icon-lg" className="group shrink-0 active:bg-transparent" {...props}>
    <span data-stop-visual={stop || undefined} data-send-visual={!stop || undefined} aria-hidden="true"
      className="pointer-events-none flex size-10 items-center justify-center rounded-full border border-primary-active bg-primary text-primary-foreground group-active:bg-primary-active">
      {stop ? <Square className="size-[18px]" fill="currentColor" /> : busy ? <Loader2 className="size-[18px] animate-spin" /> : <ArrowUp className="size-[18px]" />}
    </span>
  </Button>;
}
