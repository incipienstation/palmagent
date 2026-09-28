import type { RefObject } from "react";
import { CircleX, Search } from "lucide-react";
import { useKeyboardDismiss } from "../hooks/useKeyboardDismiss";
import { Button } from "./ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";

// Keep one input mounted as its layout moves between mobile and desktop.
export function ListSearch({ inputRef, label, clearLabel, placeholder, value, onChange }: {
  inputRef: RefObject<HTMLInputElement | null>;
  label: string;
  clearLabel: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  useKeyboardDismiss(inputRef);
  return <form role="search" aria-label={label} className="order-last shrink-0 px-4 pt-3 pb-[max(12px,var(--safe-bottom))] md:order-first md:px-6 md:py-2"
    onSubmit={event => { event.preventDefault(); inputRef.current?.blur(); }}>
    <InputGroup className="h-12 flex-nowrap gap-2 rounded-full pr-1 pl-4" onClick={() => inputRef.current?.focus()}>
      <InputGroupInput ref={inputRef} type="search" aria-label={label} placeholder={placeholder} value={value}
        onChange={event => onChange(event.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="search"
        onKeyDown={event => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault(); inputRef.current?.blur();
          }
        }} />
      <InputGroupAddon><Search aria-hidden="true" className="size-5 text-muted-foreground" /></InputGroupAddon>
      {!!value.trim() && <InputGroupAddon align="inline-end">
        <Button type="button" variant="ghost" size="icon-lg" className="rounded-full" aria-label={clearLabel}
          onPointerDown={event => event.preventDefault()} onClick={() => { onChange(""); inputRef.current?.focus(); }}>
          <CircleX />
        </Button>
      </InputGroupAddon>}
    </InputGroup>
  </form>;
}
