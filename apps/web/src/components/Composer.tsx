import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Check, ChevronDown, Loader2 } from "lucide-react";
import type { AgentKind } from "@palmagent/shared";
import { DEFAULT_OPTION, EFFORTS, MODELS, PERMISSIONS } from "../api";
import { useUpdateState } from "../update-state";
import { cn } from "@/lib/utils";
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
        <SelectContent><SelectGroup>{EFFORTS[s.agent].map((e) => <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>)}</SelectGroup></SelectContent>
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

export function Composer({ id, value, onChange, placeholder, label, action, onSend, busy, disabled,
  attachments, settings, description, controls, header, showSettings = true }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  action: string;
  onSend?: () => void;
  busy?: boolean;
  disabled?: boolean;
  attachments: ReturnType<typeof useImageAttachments>;
  settings: ComposerSettings;
  description: string;
  controls?: ReactNode;
  header?: ReactNode;
  showSettings?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const [configure, setConfigure] = useUpdateState(`composer:${id}:configure`, false);
  const [menuOpen, setMenuOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const expanded = !!header || focused || configure || menuOpen || !!value || attachments.images.length > 0 || attachments.preparing;
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
  const effort = settings.effort === DEFAULT_OPTION ? "" : EFFORTS[settings.agent].find((e) => e.value === settings.effort)?.label ?? settings.effort;

  return <InputGroup aria-label="Message composer" data-expanded={expanded}
    className={cn("p-1", expanded ? "rounded-3xl" : "rounded-full")}
    onFocusCapture={() => setFocused(true)}
    onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}>
    <InputGroupTextarea ref={textarea} id={id} aria-label={label} value={value} rows={1}
      onChange={(e) => onChange(e.target.value)} onPaste={attachments.onPaste}
      placeholder={placeholder} disabled={disabled || busy}
      className={cn("max-h-36 py-2.5", expanded ? "order-1 basis-full px-3" : "px-1")}
    />
    {header && <InputGroupAddon align="block-start" className="px-3">{header}</InputGroupAddon>}
    {attachments.images.length > 0 && <InputGroupAddon align="block-start" className="px-3 pt-2">
      <AttachmentTray images={attachments.images} disabled={busy} onRemove={attachments.remove} />
    </InputGroupAddon>}
    <InputGroupAddon align="inline-start" className={expanded ? "order-2" : undefined}>
      <AttachmentMenu open={menuOpen} onOpenChange={setMenuOpen} disabled={disabled || busy || attachments.preparing}
        preparing={attachments.preparing} onAdd={(files) => void attachments.addFiles(files)} />
    </InputGroupAddon>
    <InputGroupAddon align="inline-end" className={cn("gap-1", expanded && "min-w-0 flex-1 justify-end")}>
      {expanded && showSettings && <Sheet open={configure} onOpenChange={setConfigure} repositionInputs={false} autoFocus>
        <SheetTrigger asChild>
          <Button type="button" variant="ghost" disabled={disabled || busy} aria-label="Configure model and effort"
            className="min-w-0 max-w-full gap-1 rounded-full px-2">
            <span className="truncate">{model}{effort && <span className="font-normal text-muted-foreground"> · {effort}</span>}</span>
            <ChevronDown data-icon="inline-end" />
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
      </Sheet>}
      {controls ?? <Button type={onSend ? "button" : "submit"} onClick={onSend} aria-label={action} title={action}
        size="icon-lg" className="shrink-0"
        disabled={disabled || busy || attachments.preparing || (!value.trim() && attachments.images.length === 0)}>
        {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
      </Button>}
    </InputGroupAddon>
  </InputGroup>;
}
