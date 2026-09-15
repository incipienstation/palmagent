import { useRef, useState } from "react";
import { ArrowUp, ListPlus } from "lucide-react";
import { Button } from "./ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { haptic, useLongPress } from "../hooks/useLongPress";
import { cn } from "../lib/utils";

export function SendControl({ mode, onMode, onSend, disabled, sendDisabled }: {
  mode: "send" | "queue"; onMode: (mode: "send" | "queue") => void;
  onSend: () => void; disabled: boolean; sendDisabled: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const press = useLongPress(() => setOpen(true), () => { if (!sendDisabled) onSend(); }, disabled);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverAnchor asChild>
      <Button ref={button} type="button" size="icon-lg" className={cn("relative ml-auto shrink-0 touch-pan-y select-none [-webkit-touch-callout:none]", press.pressing && "scale-95")}
        disabled={disabled} aria-disabled={disabled || sendDisabled} aria-label={mode === "send" ? "Send now" : "Add to queue"}
        aria-haspopup="dialog" aria-expanded={open} aria-keyshortcuts="ArrowDown Shift+F10" title="Hold or press Arrow Down to choose Send or Queue" {...press.handlers}>
        {mode === "send" ? <ArrowUp /> : <ListPlus />}
      </Button>
    </PopoverAnchor>
    <PopoverContent onCloseAutoFocus={event => { event.preventDefault(); button.current?.focus(); }} side="top" align="end" className="w-64 p-2" aria-label="Message delivery">
      <ToggleGroup type="single" value={mode} aria-label="Message delivery mode" onValueChange={value => {
        if (value !== "send" && value !== "queue") return;
        if (value !== mode) { haptic("select"); onMode(value); }
        setOpen(false);
      }}>
        <ToggleGroupItem value="send">Send now</ToggleGroupItem>
        <ToggleGroupItem value="queue">Queue</ToggleGroupItem>
      </ToggleGroup>
    </PopoverContent>
  </Popover>;
}
