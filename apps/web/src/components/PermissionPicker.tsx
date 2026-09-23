import type { AgentKind } from "@palmagent/shared";
import { Check } from "lucide-react";
import { DEFAULT_PERMISSION, PERMISSION_CLI_FLAG, PERMISSIONS } from "../api";
import { Badge } from "./ui/badge";
import { Field, FieldDescription, FieldLabel } from "./ui/field";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { cn } from "@/lib/utils";

export function selectablePermission(agent: AgentKind, value: string): string {
  return PERMISSIONS[agent].some((option) => option.value === value) ? value : DEFAULT_PERMISSION[agent];
}

const LEGACY_PERMISSION_VALUE: Record<AgentKind, Record<string, string>> = {
  claude: { default: "auto", readonly: "plan", "auto-edit": "acceptEdits", full: "bypassPermissions" },
  codex: { readonly: "read-only", "auto-edit": "workspace-write", full: "danger-full-access", "workspace-write-net": "workspace-write" },
};

export function permissionLabel(agent: AgentKind, value: string): string {
  const nativeValue = LEGACY_PERMISSION_VALUE[agent][value] ?? value;
  return PERMISSIONS[agent].find((option) => option.value === nativeValue)?.label ?? value;
}

export function PermissionPicker({ agent, value, onChange, disabled }: {
  agent: AgentKind;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const selected = selectablePermission(agent, value);
  return <Field data-disabled={disabled || undefined}>
    <div className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <FieldLabel>Permission</FieldLabel>
      <code className="max-w-full break-all rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground sm:max-w-[60%] sm:text-right">
        {PERMISSION_CLI_FLAG[agent]} {selected}
      </code>
    </div>
    <ToggleGroup
      type="single"
      orientation="vertical"
      aria-label="Permission"
      value={selected}
      onValueChange={(next) => next && onChange(next)}
      disabled={disabled}
      className="flex-col rounded-2xl"
    >
      {PERMISSIONS[agent].map((option) => <ToggleGroupItem
        key={option.value}
        value={option.value}
        variant="list"
        className={cn("items-start gap-3", option.danger && "data-[state=on]:text-destructive")}
      >
        <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <span className="flex w-full min-w-0 items-center gap-2">
            <span className={cn("font-medium", option.danger && "text-destructive")}>{option.label}</span>
            <code className="min-w-0 truncate text-[11px] font-normal text-muted-foreground">{option.value}</code>
            {option.danger && <Badge variant="destructive">High risk</Badge>}
          </span>
          <span className="text-left text-sm font-normal leading-snug text-muted-foreground">{option.description}</span>
        </span>
        {selected === option.value && <Check aria-hidden="true" />}
      </ToggleGroupItem>)}
    </ToggleGroup>
    <FieldDescription>
      Passed to the {agent} CLI as <code>{PERMISSION_CLI_FLAG[agent]} {selected}</code>.
    </FieldDescription>
  </Field>;
}
