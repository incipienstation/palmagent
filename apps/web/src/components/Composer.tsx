import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Check, ChevronDown, Loader2 } from "lucide-react";
import { SkillChips, SkillMenu, SkillTrigger, useSkillPicker } from "./SkillPicker";
import { Popover, PopoverAnchor } from "./ui/popover";
import type { SkillContext, SkillSelection } from "@palmagent/shared";
import type { AgentKind } from "@palmagent/shared";
import { DEFAULT_OPTION, effortsForModel, MODELS, PERMISSIONS } from "../api";
import { useUpdateState } from "../update-state";
import { useSendShortcut } from "../SendShortcutProvider";
import { AttachmentMenu, AttachmentTray, type useImageAttachments } from "./Attachments";
import { Button } from "./ui/button";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "./ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "./ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

export interface ComposerSettings {
  agent: AgentKind;
  onAgentChange?: (agent: AgentKind) => void;
  model: string;
  onModelChange: (value: string) => void;
  effort: string;
  onEffortChange: (value: string) => void;
  permission: string;
  onPermissionChange: (value: string) => void;
  children?: ReactNode;
}

function Configuration({ settings: s, description }: { settings: ComposerSettings; description: string }) {
  const models = MODELS[s.agent].some((m) => m.value === s.model)
    ? MODELS[s.agent] : [...MODELS[s.agent], { value: s.model, label: s.model }];
  return <FieldGroup className="gap-6">
    {s.onAgentChange && <Field>
      <FieldLabel>Agent</FieldLabel>
      <ToggleGroup type="single" aria-label="Agent" value={s.agent} onValueChange={(v) => v && s.onAgentChange?.(v as AgentKind)}>
        {(["claude", "codex"] as const).map((agent) => <ToggleGroupItem key={agent} value={agent}>{agent}</ToggleGroupItem>)}
      </ToggleGroup>
    </Field>}
    <Field>
      <FieldLabel>Model</FieldLabel>
      <ToggleGroup type="single" orientation="vertical" aria-label="Model" value={s.model}
        onValueChange={(v) => v && s.onModelChange(v)} className="flex-col rounded-3xl">
        {models.map((m) => <ToggleGroupItem key={m.value} value={m.value}
          variant="list">
          <span className="min-w-0 break-words">{m.value === DEFAULT_OPTION ? "Default" : m.label}
            {m.value === DEFAULT_OPTION && <span className="block text-xs font-normal text-muted-foreground">Use the agent's default model</span>}
          </span>
          {s.model === m.value && <Check className="size-5 shrink-0" aria-hidden="true" />}
        </ToggleGroupItem>)}
      </ToggleGroup>
    </Field>
    <Field orientation="horizontal">
      <FieldLabel htmlFor="composer-effort">Effort</FieldLabel>
      <Select value={s.effort} onValueChange={(v) => v && s.onEffortChange(v)}>
        <SelectTrigger id="composer-effort" className="w-auto min-w-32 rounded-full"><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>{effortsForModel(s.agent, s.model).map((e) => <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>)}</SelectGroup></SelectContent>
      </Select>
    </Field>
    <Field>
      <FieldLabel htmlFor="composer-permission">Permission</FieldLabel>
      <Select value={s.permission} onValueChange={(v) => v && s.onPermissionChange(v)}>
        <SelectTrigger id="composer-permission" className="rounded-full"><SelectValue /></SelectTrigger>
        <SelectContent className="max-w-[calc(100vw-2rem)]"><SelectGroup>
          {PERMISSIONS[s.agent].map((p) => <SelectItem key={p.value} value={p.value} textValue={p.label} description={p.description}>
            <span className={p.danger ? "text-destructive" : undefined}>{p.label}</span>
          </SelectItem>)}
        </SelectGroup></SelectContent>
      </Select>
    </Field>
    {s.children}
    <p className="text-xs text-muted-foreground">{description}</p>
  </FieldGroup>;
}

export function Composer({ id, value, onChange, placeholder, label, action, onSend, busy, disabled, sendDisabled,
  attachments, settings, description, controls, header, settingsReadOnly, skillContext, skills, onSkillsChange }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  action: string;
  onSend?: () => void;
  busy?: boolean;
  disabled?: boolean;
  sendDisabled?: boolean;
  attachments: ReturnType<typeof useImageAttachments>;
  settings: ComposerSettings;
  description: string;
  controls?: ReactNode;
  header?: ReactNode;
  settingsReadOnly?: string;
  skillContext?: SkillContext;
  skills?: SkillSelection[];
  onSkillsChange?: (skills: SkillSelection[]) => void;
}) {
  const [focused, setFocused] = useState(false);
  const [configure, setConfigure] = useUpdateState(`composer:${id}:configure`, false);
  const [menuOpen, setMenuOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const { shortcut } = useSendShortcut();
  const picker = useSkillPicker({ value, onChange, context: skillContext, onSelect: onSkillsChange, textarea, disabled: disabled || busy });
  const cannotSend = disabled || busy || sendDisabled || attachments.preparing || (!value.trim() && attachments.images.length === 0 && !skills?.length);
  const expanded = !!skills?.length || picker.open || !!header || focused || configure || menuOpen || !!value || attachments.images.length > 0 || attachments.preparing;
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    const resize = () => {
      el.style.height = "0px";
      el.style.height = `${Math.max(expanded ? 56 : 44, Math.min(el.scrollHeight, 144))}px`;
    };
    resize();
    const observer = new ResizeObserver(() => {
      // Width changes can wrap text without a value change (rotation/split view).
      if (el.dataset.width !== String(el.clientWidth)) { el.dataset.width = String(el.clientWidth); resize(); }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [value, expanded]);
  const model = settings.model === DEFAULT_OPTION
    ? (settings.agent === "claude" ? "Claude" : "Codex")
    : MODELS[settings.agent].find((m) => m.value === settings.model)?.label ?? settings.model;
  const effort = settings.effort === DEFAULT_OPTION ? "" : effortsForModel(settings.agent, settings.model).find((e) => e.value === settings.effort)?.label ?? settings.effort;

  return <Popover open={picker.open} onOpenChange={open => { if (!open) picker.close(); }}><PopoverAnchor asChild><InputGroup aria-label="Message composer" data-expanded={expanded}
    className="rounded-3xl p-1"
    onFocusCapture={() => setFocused(true)}
    onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}>
    <InputGroupTextarea ref={textarea} id={id} aria-label={label} value={value} rows={1}
      onChange={(e) => { onChange(e.target.value); picker.cursor(e.target, true); }} onPaste={attachments.onPaste}
      onSelect={e => picker.cursor(e.currentTarget)}
      aria-autocomplete={skillContext ? "list" : undefined} aria-controls={picker.open ? picker.id : undefined}
      aria-haspopup={skillContext ? "listbox" : undefined}
      aria-activedescendant={picker.open && picker.matches.length && !picker.loading ? `${picker.id}-${picker.selected}` : undefined}
      aria-keyshortcuts={shortcut === "enter" ? "Enter Meta+Enter Control+Enter" : "Meta+Enter Control+Enter"}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onBlur={() => { composing.current = false; }}
      onKeyDown={(event) => {
        if (!event.defaultPrevented && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && picker.keyDown(event)) return;
        // keyCode 229 also covers IME confirmation in browsers that end
        // composition before dispatching the final Enter keydown.
        if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey || event.altKey ||
          composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (shortcut !== "enter" && !event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        if (event.repeat || cannotSend) return;
        if (onSend) onSend();
        else if (!controls) event.currentTarget.form?.requestSubmit();
      }}
      placeholder={placeholder} disabled={disabled || busy}
      className="order-1 max-h-36 basis-full px-3 py-2.5"
    />
    {!!skills?.length && <InputGroupAddon align="block-start" className="px-3 pt-2"><SkillChips skills={skills} disabled={disabled || busy} onRemove={() => onSkillsChange?.([])} /></InputGroupAddon>}
    {header && <InputGroupAddon align="block-start" className="px-3">{header}</InputGroupAddon>}
    {attachments.images.length > 0 && <InputGroupAddon align="block-start" className="px-3 pt-2">
      <AttachmentTray images={attachments.images} disabled={busy} onRemove={attachments.remove} />
    </InputGroupAddon>}
    <InputGroupAddon align="inline-start" className="order-2 shrink-0">
      <AttachmentMenu open={menuOpen} onOpenChange={setMenuOpen} disabled={disabled || busy || attachments.preparing}
        preparing={attachments.preparing} onAdd={(files) => void attachments.addFiles(files)} />
      {skillContext && onSkillsChange && <SkillTrigger onClick={picker.trigger} disabled={disabled || busy} open={picker.open} />}
    </InputGroupAddon>
    <InputGroupAddon align="inline-end" className="min-w-0 flex-1 justify-end gap-1">
      <Sheet open={configure && !settingsReadOnly} onOpenChange={setConfigure} repositionInputs={false} autoFocus>
        <SheetTrigger asChild>
          <Button type="button" variant="ghost" disabled={disabled || busy || !!settingsReadOnly}
            aria-label={settingsReadOnly ? "Current model and effort" : "Configure model and effort"}
            title={settingsReadOnly ? `${model}${effort ? ` · ${effort}` : ""} — ${settingsReadOnly}` : `${model}${effort ? ` · ${effort}` : ""}`}
            className="min-w-0 gap-1 rounded-full px-2">
            <span className="truncate">{model}</span>
            {effort && <span className="shrink-0 font-normal text-muted-foreground"> · {effort}</span>}
            {!settingsReadOnly && <ChevronDown data-icon="inline-end" />}
          </Button>
        </SheetTrigger>
        <SheetContent className="bottom-[var(--keyboard-inset,0px)] max-h-[calc(var(--app-height)-16px)] rounded-t-3xl"
          onCloseAutoFocus={(event) => {
            // Dismissal finishes after the closing animation. Do not steal
            // focus if the user has already returned to their draft.
            if (document.activeElement === textarea.current) event.preventDefault();
          }}>
          <SheetHeader className="shrink-0 pb-4 text-center">
            <SheetTitle>Configure</SheetTitle>
            <SheetDescription>{settings.onAgentChange ? "Settings for this new task." : "Settings for the next message."}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 overflow-y-auto overscroll-contain px-5 pb-5" data-slot="settings-scroll" data-vaul-no-drag>
            <Configuration settings={settings} description={description} />
          </div>
          <div className="shrink-0 px-5 pt-3">
            <Button type="button" className="w-full rounded-full" onClick={() => setConfigure(false)}>Done</Button>
          </div>
        </SheetContent>
      </Sheet>
      {controls ?? <Button type={onSend ? "button" : "submit"} onClick={onSend} aria-label={action} title={action}
        size="icon-lg" className="shrink-0"
        disabled={cannotSend}>
        {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
      </Button>}
    </InputGroupAddon>
  </InputGroup></PopoverAnchor><SkillMenu picker={picker} textarea={textarea} /></Popover>;
}
