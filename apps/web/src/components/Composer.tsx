import { useVoiceInput } from "../use-voice-input";
import { Alert } from "./ui/alert";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Check, ChevronDown, Loader2, Mic, Square } from "lucide-react";
import { SkillChips, SkillMenu, SkillTrigger, useSkillPicker } from "./SkillPicker";
import { Popover, PopoverAnchor } from "./ui/popover";
import type { SkillContext, SkillSelection } from "@palmagent/shared";
import type { AgentKind } from "@palmagent/shared";
import { DEFAULT_OPTION } from "../api";
import { effortChoices, modelChoices, useAgentCatalog } from "../model-catalog";
import { useUpdateState } from "../update-state";
import { useSendShortcut } from "../SendShortcutProvider";
import { AttachmentMenu, AttachmentTray, type useImageAttachments } from "./Attachments";
import { Button } from "./ui/button";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "./ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "./ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { PermissionPicker, permissionLabel } from "./PermissionPicker";

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
  const catalog = useAgentCatalog(s.agent);
  const models = modelChoices(catalog, s.model);
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
        <SelectContent><SelectGroup>{effortChoices(catalog, s.model, s.effort).map((e) => <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>)}</SelectGroup></SelectContent>
      </Select>
    </Field>
    <PermissionPicker agent={s.agent} value={s.permission} onChange={s.onPermissionChange} />
    {s.children}
    <p className="text-xs text-muted-foreground">{description}</p>
  </FieldGroup>;
}

function VoiceWaveform({ levels }: { levels: number[] }) {
  return <div aria-hidden="true" data-voice-waveform className="flex h-8 min-w-0 flex-1 items-center justify-center gap-[2px] overflow-hidden px-1">
    {levels.map((level, index) => <span key={index}
      className="h-full min-w-[2px] max-w-[3px] flex-1 rounded-full bg-muted-foreground/75 transition-[height] duration-75 motion-reduce:transition-none"
      style={{ height: `${12 + Math.min(0.88, level) * 88}%` }} />)}
  </div>;
}

export function Composer({ id, value, onChange, placeholder, label, action, onSend, onStop, stopping, busy, disabled, sendDisabled,
  attachments, settings, description, controls, header, settingsReadOnly, skillContext, skills, onSkillsChange, voiceScope = id }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  action: string;
  onSend?: () => void;
  onStop?: () => void;
  stopping?: boolean;
  busy?: boolean;
  disabled?: boolean;
  sendDisabled?: boolean;
  attachments: ReturnType<typeof useImageAttachments>;
  settings: ComposerSettings;
  description: string;
  controls?: ReactNode;
  header?: ReactNode;
  settingsReadOnly?: string;
  voiceScope?: string;
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
  const catalog = useAgentCatalog(settings.agent);
  const picker = useSkillPicker({ value, onChange, context: skillContext, onSelect: onSkillsChange, textarea, disabled: disabled || busy });
  const latest = useRef({ value, onChange }); latest.current = { value, onChange };
  const voice = useVoiceInput(settings.agent === "codex" ? skillContext : undefined, voiceScope, !!(disabled || busy), text => {
    const draft = latest.current.value;
    const next = draft + (draft && !/\s$/.test(draft) ? " " : "") + text;
    latest.current.value = next; latest.current.onChange(next);
  }, () => !composing.current);
  const cannotSend = voice.active || disabled || busy || sendDisabled || attachments.preparing || (!value.trim() && attachments.images.length === 0 && !skills?.length);
  const expanded = voice.active || !!voice.error || !!skills?.length || picker.open || !!header || focused || configure || menuOpen || !!value || attachments.images.length > 0 || attachments.preparing;
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
    : modelChoices(catalog, settings.model).find((m) => m.value === settings.model)?.label ?? settings.model;
  const effort = settings.effort === DEFAULT_OPTION ? "" : effortChoices(catalog, settings.model, settings.effort).find((e) => e.value === settings.effort)?.label ?? settings.effort;
  const permission = permissionLabel(settings.agent, settings.permission);

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
    {(voice.error || voice.active) && <InputGroupAddon align="block-start" className="px-3">
      {voice.error ? <Alert variant="destructive">{voice.error}</Alert>
        : <span role="status" className="text-xs text-muted-foreground">{voice.state === "starting" ? "Connecting microphone…" : voice.state === "stopping" ? "Finishing transcription…" : "Listening… tap the microphone to finish."}</span>}
    </InputGroupAddon>}
    {!!skills?.length && <InputGroupAddon align="block-start" className="px-3 pt-2"><SkillChips skills={skills} disabled={disabled || busy} onRemove={() => onSkillsChange?.([])} /></InputGroupAddon>}
    {header && <InputGroupAddon align="block-start" className="px-3">{header}</InputGroupAddon>}
    {attachments.images.length > 0 && <InputGroupAddon align="block-start" className="px-3 pt-2">
      <AttachmentTray images={attachments.images} disabled={busy} onRemove={attachments.remove} />
    </InputGroupAddon>}
    <InputGroupAddon align="inline-start" className="order-2 shrink-0">
      <AttachmentMenu open={menuOpen} onOpenChange={setMenuOpen} disabled={disabled || busy || attachments.preparing}
        preparing={attachments.preparing} onAdd={(files) => void attachments.addFiles(files)}
        voiceActive={voice.active} onCancelVoice={voice.cancel} />
      {skillContext && onSkillsChange && <SkillTrigger onClick={picker.trigger} disabled={disabled || busy} open={picker.open} />}
    </InputGroupAddon>
    <InputGroupAddon align="inline-end" className="min-w-0 flex-1 justify-end gap-1">
      {voice.active && <VoiceWaveform levels={voice.meter} />}
      <Sheet open={configure && !settingsReadOnly} onOpenChange={setConfigure} repositionInputs={false} autoFocus>
        <SheetTrigger asChild>
          <Button type="button" variant="ghost" disabled={disabled || busy || !!settingsReadOnly}
            aria-label={settingsReadOnly ? "Current task settings" : "Configure task settings"}
            title={settingsReadOnly ? `${model}${effort ? ` · ${effort}` : ""} · ${permission} — ${settingsReadOnly}` : `${model}${effort ? ` · ${effort}` : ""} · ${permission}`}
            className="min-w-0 gap-1 rounded-full px-2">
            <span className="truncate">{model}</span>
            {effort && <span className="shrink-0 font-normal text-muted-foreground"> · {effort}</span>}
            <span className="hidden shrink-0 font-normal text-muted-foreground sm:inline"> · {permission}</span>
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
      {settings.agent === "codex" && <Button type="button" variant={voice.active ? "selected" : "ghost"} size="icon-lg"
        className="shrink-0" aria-label={voice.active ? "Stop voice input" : "Start voice input"} title={voice.active ? "Stop voice input" : "Start voice input"}
        aria-pressed={voice.active} disabled={disabled || busy || !skillContext || voice.state === "stopping"} onClick={() => { setMenuOpen(false); voice.toggle(); }}>
        {voice.state === "starting" || voice.state === "stopping" ? <Loader2 className="animate-spin" /> : voice.active ? <Square /> : <Mic />}
      </Button>}
      {onStop && <Button type="button" variant="ghost" size="icon-lg" className="group shrink-0 active:bg-transparent" aria-label="Stop" title={stopping ? "Stopping turn…" : "Stop"}
        disabled={stopping} onClick={onStop}>
        <span data-stop-visual="true" aria-hidden="true" className="pointer-events-none flex size-10 items-center justify-center rounded-full border border-primary-active bg-primary text-primary-foreground group-active:bg-primary-active">
          <Square className="size-[18px]" fill="currentColor" />
        </span>
      </Button>}
      {controls ? <fieldset disabled={voice.active} className="min-w-0 shrink-0 disabled:opacity-40">{controls}</fieldset> : !onStop && <Button type={onSend ? "button" : "submit"} onClick={onSend} aria-label={action} title={action}
        variant="ghost" size="icon-lg" className="group shrink-0 active:bg-transparent"
        disabled={cannotSend}>
        <span data-send-visual="true" aria-hidden="true" className="pointer-events-none flex size-10 items-center justify-center rounded-full border border-primary-active bg-primary text-primary-foreground group-active:bg-primary-active">
          {busy ? <Loader2 className="size-[18px] animate-spin" /> : <ArrowUp className="size-[18px]" />}
        </span>
      </Button>}
    </InputGroupAddon>
  </InputGroup></PopoverAnchor><SkillMenu picker={picker} textarea={textarea} /></Popover>;
}
