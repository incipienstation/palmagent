import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { BookOpen, Slash, X } from "lucide-react";
import { SelectedSkillsSchema, type AvailableSkill, type SkillContext, type SkillSelection } from "@palmagent/shared";
import { api } from "../api";
import { useDraft } from "../hooks/useDraft";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { PopoverContent } from "./ui/popover";
import { cn } from "../lib/utils";

export function useSkillDraft(key: string): [SkillSelection[], (skills: SkillSelection[]) => void] {
  const [raw, setRaw] = useDraft(key);
  let skills: SkillSelection[] = [];
  try { skills = SelectedSkillsSchema.parse(JSON.parse(raw || "[]")) ?? []; } catch { /* old or invalid draft */ }
  return [skills, values => setRaw(values.length ? JSON.stringify(values) : "")];
}

function SkillIcon({ skill }: { skill: SkillSelection }) {
  return skill.pluginId?.split("@")[0] === "palmagent"
    ? <img src="/logo.svg" alt="Palmagent plugin" className="size-4 shrink-0" />
    : <BookOpen className="size-4 shrink-0" aria-hidden />;
}
export function SkillChips({ skills, onRemove, disabled }: { skills?: SkillSelection[]; onRemove?: () => void; disabled?: boolean }) {
  if (!skills?.length) return null;
  return <div className="flex min-w-0 flex-wrap gap-1" aria-label="Selected skills">
    {skills.map(skill => <Badge key={skill.id} variant="outline" className="min-w-0 max-w-full gap-1.5" title={`${skill.source} · ${skill.name}`}>
      <SkillIcon skill={skill} /><span className="truncate">{skill.name}</span>
      {onRemove && <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={`Remove ${skill.name} skill`} onClick={onRemove}><X /></Button>}
    </Badge>)}
  </div>;
}

// Slash must begin a token; URLs and ./paths do not open the menu. A second
// slash closes it, leaving absolute paths and literal text untouched.
export function slashToken(value: string, caret: number) {
  if (caret < 0 || caret > value.length) return null;
  const match = /(?:^|\s)\/([\p{L}\p{N}_.:-]*)$/u.exec(value.slice(0, caret));
  return match ? { start: caret - match[1].length - 1, end: caret, query: match[1] } : null;
}
export function useSkillPicker({ value, onChange, context, onSelect, textarea, disabled }: {
  value: string; onChange: (text: string) => void; context?: SkillContext;
  onSelect?: (skills: SkillSelection[]) => void; textarea: RefObject<HTMLTextAreaElement | null>; disabled?: boolean;
}) {
  const id = useId();
  const [caret, setCaret] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const [catalog, setCatalog] = useState<AvailableSkill[]>([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState(""), [warning, setWarning] = useState("");
  const [reload, setReload] = useState(0), [active, setActive] = useState(0);
  const contextKey = JSON.stringify(context);
  const token = slashToken(value, caret);
  const open = !!context && !!onSelect && !!token && !dismissed && !disabled;
  useEffect(() => {
    const el = textarea.current;
    // A repository can finish loading after the user has already typed `/`.
    // Keep the focused caret while switching discovery to the new context.
    setCaret(el && document.activeElement === el && el.selectionStart === el.selectionEnd ? el.selectionStart : -1);
    setDismissed(false);
  }, [contextKey]);
  useEffect(() => {
    if (!open || !context) return;
    let current = true;
    setLoading(true); setError(""); setCatalog([]); setWarning("");
    void api.skills(context).then(result => {
      if (current) { setCatalog(result.skills); setWarning(result.warning ?? ""); }
    }).catch(e => { if (current) setError(e instanceof Error ? e.message : "Could not load skills."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [open, contextKey, reload]);
  const query = token?.query.toLocaleLowerCase() ?? "";
  const matches = catalog.filter(s => `${s.name} ${s.description} ${s.source}`.toLocaleLowerCase().includes(query));
  useEffect(() => setActive(0), [query, catalog]);
  const selected = Math.min(active, Math.max(0, matches.length - 1));
  function pick(skill: AvailableSkill) {
    if (!token) return;
    const { description: _, ...ref } = skill;
    onSelect?.([ref]);
    onChange(value.slice(0, token.start) + value.slice(token.end));
    setDismissed(true);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(token.start, token.start); });
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return false;
    if (event.key === "Escape") { event.preventDefault(); setDismissed(true); return true; }
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault(); setActive(i => matches.length ? (i + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length : 0); return true;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault(); if (!event.repeat && matches[selected] && !loading) pick(matches[selected]); return true;
    }
    return false;
  }
  return { id, open, matches, loading, error, warning, selected, pick, keyDown,
    close: () => setDismissed(true), retry: () => setReload(n => n + 1),
    cursor: (el: HTMLTextAreaElement, changed = false) => { setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : -1); if (changed) setDismissed(false); },
    trigger: () => {
      const el = textarea.current, start = el?.selectionStart ?? value.length, end = el?.selectionEnd ?? start;
      const prefix = start > 0 && !/\s/.test(value[start - 1]) ? " /" : "/";
      onChange(value.slice(0, start) + prefix + value.slice(end));
      setCaret(start + prefix.length); setDismissed(false);
      requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + prefix.length, start + prefix.length); });
    },
  };
}
export function SkillMenu({ picker, textarea }: { picker: ReturnType<typeof useSkillPicker>; textarea: RefObject<HTMLTextAreaElement | null> }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [picker.selected]);
  return <PopoverContent side="top" align="start" className="w-[min(26rem,calc(100vw-2rem))] p-2" aria-label="Skills"
    onOpenAutoFocus={e => e.preventDefault()} onCloseAutoFocus={e => e.preventDefault()}
    onInteractOutside={e => { if (e.target === textarea.current) e.preventDefault(); }}>
    <div className="flex items-center justify-between px-2 pb-1 text-sm text-muted-foreground"><span>Skills</span><span>Type / to search</span></div>
    {picker.loading ? <p role="status" className="p-2 text-sm">Loading skills…</p>
      : picker.error ? <div className="p-2"><p role="alert" className="text-sm">{picker.error}</p><Button type="button" variant="ghost" onClick={picker.retry}>Try again</Button></div>
      : <div ref={list} id={picker.id} role="listbox" aria-label="Available skills" className="max-h-[min(16rem,35dvh)] overflow-y-auto overscroll-contain">
        {picker.matches.length === 0 && <p role="status" className="p-2 text-sm text-muted-foreground">No matching skills in this environment.</p>}
        {picker.matches.map((skill, index) => <Button key={skill.id} type="button" role="option" id={`${picker.id}-${index}`}
          aria-selected={picker.selected === index} tabIndex={-1} variant="ghost"
          className={cn("h-auto min-h-12 w-full justify-start gap-3 whitespace-normal px-2 py-2 text-left", picker.selected === index && "bg-accent")}
          onMouseDown={e => e.preventDefault()} onClick={() => picker.pick(skill)}>
          <SkillIcon skill={skill} /><span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="break-words">{skill.name}</span><span className="line-clamp-2 text-xs font-normal text-muted-foreground">{skill.description}</span>
            <span className="text-xs font-normal text-muted-foreground">{skill.source}</span>
          </span>
        </Button>)}
      </div>}
    {picker.warning && <p role="status" className="p-2 text-xs text-muted-foreground">{picker.warning}</p>}
  </PopoverContent>;
}
export function SkillTrigger({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return <Button type="button" variant="ghost" size="icon-lg" aria-label="Choose a skill" title="Skills (/)" disabled={disabled} onClick={onClick}><Slash /></Button>;
}
