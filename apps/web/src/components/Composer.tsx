import { VoiceWaveform } from "./VoiceWaveform";
import { ComposerAction, ComposerInput, ComposerSurface } from "./ComposerPrimitives";
import { useVoiceInput } from "../use-voice-input";
import { Alert } from "./ui/alert";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Loader2, Mic, Square } from "lucide-react";
import { SkillChips, SkillMenu, SkillTrigger, useSkillPicker } from "./SkillPicker";
import { Popover, PopoverAnchor } from "./ui/popover";
import type { SkillContext, SkillSelection } from "@palmagent/shared";
import type { AgentKind } from "@palmagent/shared";
import { DEFAULT_OPTION } from "../api";
import { effortChoices, modelChoices, useAgentCatalog } from "../model-catalog";
import { useUpdateState } from "../update-state";
import { AttachmentMenu, AttachmentTray, type useImageAttachments } from "./Attachments";
import { Button } from "./ui/button";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { InputGroupAddon } from "./ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "./ui/sheet";
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

export function Composer({ id, value, onChange, placeholder, label, action, onSend, onStop, stopping, busy, disabled, sendDisabled,
  attachments, settings, description, controls, header, settingsReadOnly, skillContext, skills, onSkillsChange, commandActive, voiceScope = id }: {
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
  /** A built-in command owns the slash token and submission. */
  commandActive?: boolean;
}) {
  const [configure, setConfigure] = useUpdateState(`composer:${id}:configure`, false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    // Removing a focused action (Send becoming Stop, for example) does not
    // dispatch blur in every browser. Reconcile after DOM updates as well.
    if (focused && !textarea.current?.closest(".composer")?.contains(document.activeElement)) setFocused(false);
  });
  const composing = useRef(false);
  const catalog = useAgentCatalog(settings.agent);
  const picker = useSkillPicker({ value, onChange, context: skillContext, onSelect: onSkillsChange, textarea, disabled: disabled || busy || commandActive });
  const latest = useRef({ value, onChange }); latest.current = { value, onChange };
  const voice = useVoiceInput(settings.agent === "codex" ? skillContext : undefined, voiceScope, !!(disabled || busy), text => {
    const draft = latest.current.value;
    const next = draft + (draft && !/\s$/.test(draft) ? " " : "") + text;
    latest.current.value = next; latest.current.onChange(next);
  }, () => !composing.current);
  const hasDraft = !!value.trim() || attachments.images.length > 0 || !!skills?.length;
  const compactVoice = voice.active && !hasDraft;
  const cannotSend = voice.active || disabled || busy || sendDisabled || attachments.preparing || !hasDraft;
  const expanded = hasDraft || focused || voice.active || !!voice.error || picker.open || !!header || configure || menuOpen || attachments.preparing;
  const model = settings.model === DEFAULT_OPTION
    ? (settings.agent === "claude" ? "Claude" : "Codex")
    : modelChoices(catalog, settings.model).find((m) => m.value === settings.model)?.label ?? settings.model;
  const effort = settings.effort === DEFAULT_OPTION ? "" : effortChoices(catalog, settings.model, settings.effort).find((e) => e.value === settings.effort)?.label ?? settings.effort;
  const permission = permissionLabel(settings.agent, settings.permission);

  return <Popover open={picker.open} onOpenChange={open => { if (!open) picker.close(); }}><PopoverAnchor asChild><ComposerSurface aria-label="Message composer" data-expanded={expanded}
    data-voice={settings.agent === "codex"} data-voice-active={voice.active}
    onFocusCapture={event => {
      // React also bubbles focus from portalled menus outside this surface.
      if (event.currentTarget.contains(event.target)) setFocused(true);
    }}
    onBlurCapture={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
    }}
    pending={busy || stopping}>
    <ComposerInput textarea={textarea} composing={composing} expanded={expanded} hidden={compactVoice}
      id={id} aria-label={label} value={value} placeholder={placeholder} disabled={disabled || busy}
      cannotSend={cannotSend} onSend={onSend} submitOnEnter={!controls}
      onChange={e => { onChange(e.target.value); picker.cursor(e.target, true); }} onPaste={attachments.onPaste}
      onSelect={e => picker.cursor(e.currentTarget)}
      aria-autocomplete={skillContext ? "list" : undefined} aria-controls={picker.open ? picker.id : undefined}
      aria-haspopup={skillContext ? "listbox" : undefined}
      aria-activedescendant={picker.open && picker.matches.length && !picker.loading ? `${picker.id}-${picker.selected}` : undefined}
      onKeyDown={event => { if (!event.defaultPrevented) picker.keyDown(event); }}
    />
    {voice.active && <span role="status" className="sr-only">{voice.state === "stopping" ? "Finishing transcription…" : "Recording…"}</span>}
    {voice.error && <InputGroupAddon align="block-start" className="px-3">
      <Alert variant="destructive">{voice.error}</Alert>
    </InputGroupAddon>}
    {!!skills?.length && <InputGroupAddon align="block-start" className="px-3 pt-2"><SkillChips skills={skills} disabled={disabled || busy} onRemove={() => onSkillsChange?.([])} /></InputGroupAddon>}
    {header && <InputGroupAddon align="block-start" className="px-3">{header}</InputGroupAddon>}
    {attachments.images.length > 0 && <InputGroupAddon align="block-start" className="px-3 pt-2">
      <AttachmentTray images={attachments.images} disabled={busy} onRemove={attachments.remove} />
    </InputGroupAddon>}
    <InputGroupAddon align="inline-start" className="composer-toolbar order-2 shrink-0">
      <AttachmentMenu open={menuOpen} onOpenChange={setMenuOpen} disabled={disabled || busy || attachments.preparing}
        preparing={attachments.preparing} onAdd={(files) => void attachments.addFiles(files)}
        voiceActive={voice.active} onCancelVoice={voice.cancel} />
      {!voice.active && skillContext && onSkillsChange && <span className="composer-skill" inert={!expanded}>
        <SkillTrigger onClick={picker.trigger} disabled={disabled || busy} open={picker.open} />
      </span>}
    </InputGroupAddon>
    <InputGroupAddon align="inline-end" className="composer-toolbar composer-actions min-w-0 flex-1 justify-end gap-1">
      {voice.active && <VoiceWaveform levels={voice.meter} />}
      <Sheet open={configure && !settingsReadOnly} onOpenChange={setConfigure} repositionInputs={false} autoFocus>
        {!voice.active && <span className="composer-settings min-w-0" inert={!expanded}><SheetTrigger asChild>
          <Button type="button" variant="ghost"
            disabled={disabled || busy || !!settingsReadOnly}
            aria-label={settingsReadOnly ? "Current task settings" : "Configure task settings"}
            title={settingsReadOnly ? `${model}${effort ? ` · ${effort}` : ""} · ${permission} — ${settingsReadOnly}` : `${model}${effort ? ` · ${effort}` : ""} · ${permission}`}
            className="max-w-full min-w-0 gap-1 rounded-full px-2">
            <span className="truncate">{model}</span>
            {effort && <span className="shrink-0 font-normal text-muted-foreground"> · {effort}</span>}
            <span className="hidden shrink-0 font-normal text-muted-foreground sm:inline"> · {permission}</span>
            {!settingsReadOnly && <ChevronDown data-icon="inline-end" />}
          </Button>
        </SheetTrigger></span>}
        <SheetContent className="bottom-[var(--keyboard-inset,0px)]"
          onCloseAutoFocus={(event) => {
            // Dismissal finishes after the closing animation. Do not steal
            // focus if the user has already returned to their draft.
            if (document.activeElement === textarea.current) event.preventDefault();
          }}>
          <SheetHeader>
            <SheetTitle>Configure</SheetTitle>
            <SheetDescription>{settings.onAgentChange ? "Settings for this new task." : "Settings for the next message."}</SheetDescription>
          </SheetHeader>
          <SheetBody data-slot="settings-scroll" data-vaul-no-drag>
            <Configuration settings={settings} description={description} />
          </SheetBody>
          <SheetFooter>
            <Button type="button" onClick={() => setConfigure(false)}>Done</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      {settings.agent === "codex" && <Button type="button" variant={voice.active ? "secondary" : "ghost"} size="icon-lg"
        className="shrink-0" aria-label={voice.active ? "Stop voice input" : "Start voice input"} title={voice.active ? "Stop voice input" : "Start voice input"}
        aria-pressed={voice.active} disabled={disabled || busy || !skillContext || voice.state === "stopping"} onClick={() => { setMenuOpen(false); setConfigure(false); picker.close(); voice.toggle(); }}>
        {voice.state === "stopping" ? <Loader2 className="animate-spin" /> : voice.active ? <Square /> : <Mic />}
      </Button>}
      {onStop && <ComposerAction stop aria-label="Stop" title={stopping ? "Stopping turn…" : "Stop"}
        disabled={stopping} onClick={onStop} />}
      {controls ? <fieldset disabled={voice.active} className="min-w-0 shrink-0 disabled:opacity-40">{controls}</fieldset> : !onStop &&
        <ComposerAction type={onSend ? "button" : "submit"} onClick={onSend} aria-label={action} title={action}
          disabled={cannotSend} busy={busy} />}
    </InputGroupAddon>
  </ComposerSurface></PopoverAnchor><SkillMenu picker={picker} textarea={textarea} /></Popover>;
}
